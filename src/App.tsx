import React, { useState, useCallback, useEffect } from 'react';
import MsgReader from 'msgreader';
import { Upload, FileText, Download, Mail, User, Calendar, Paperclip, X, AlertCircle, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI } from "@google/genai";
import * as XLSX from 'xlsx';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Attachment {
  fileName: string;
  content: Uint8Array;
  dataId?: number;
  extension?: string;
}

interface EmailData {
  subject?: string;
  senderName?: string;
  senderEmail?: string;
  recipients?: { name: string; email: string }[];
  body?: string;
  bodyHTML?: string;
  attachments: Attachment[];
  headers?: string;
  receivedTime?: string;
}

export default function App() {
  const [emailData, setEmailData] = useState<EmailData | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [copied, setCopied] = useState(false);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const downloadExcel = () => {
    if (!summary) return;

    // Parse summary
    const lines = summary.split('\n');
    let temat = '';
    let nadawca = '';
    let dataWplywu = '';
    let zalaczniki: string[] = [];
    let isZalacznikiSection = false;

    lines.forEach(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('Temat:')) {
        temat = trimmedLine.replace('Temat:', '').trim();
      } else if (trimmedLine.startsWith('Nadawca:')) {
        nadawca = trimmedLine.replace('Nadawca:', '').trim();
      } else if (trimmedLine.startsWith('Data wpływu:')) {
        dataWplywu = trimmedLine.replace('Data wpływu:', '').trim();
      } else if (trimmedLine.startsWith('Załączniki:')) {
        isZalacznikiSection = true;
      } else if (isZalacznikiSection && trimmedLine) {
        zalaczniki.push(`• ${trimmedLine}`);
      }
    });

    const zalacznikiStr = zalaczniki.join('\n');

    // Parse claim number
    let numerSzkody = '';
    const numerSzkodyLine = lines.find(l => l.trim().startsWith('Numer szkody:'));
    if (numerSzkodyLine) {
      numerSzkody = numerSzkodyLine.replace('Numer szkody:', '').trim();
    }

    // Create Excel workbook and worksheet
    const data = [
      {
        'Numer szkody': numerSzkody,
        'Temat': temat,
        'Nadawca': nadawca,
        'Data wpływu': dataWplywu,
        'Załączniki': zalacznikiStr
      }
    ];

    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Analiza");

    // Set column widths
    const wscols = [
      { wch: 25 }, // Numer szkody
      { wch: 40 }, // Temat
      { wch: 30 }, // Nadawca
      { wch: 20 }, // Data wpływu
      { wch: 50 }, // Załączniki
    ];
    worksheet['!cols'] = wscols;

    // Generate Excel file and trigger download
    XLSX.writeFile(workbook, `analiza_${new Date().getTime()}.xlsx`);
  };

  const generateSummary = async (data: EmailData) => {
    // Check for claim number in subject
    const claimNumberRegex = /[A-Z]{2,3}\d+-\d{5}\/\d{2}-\d{2}/;
    const match = data.subject?.match(claimNumberRegex);
    
    if (!match) {
      setSummary("Brak numeru szkody w tytule maila");
      return;
    }

    const claimNumber = match[0];
    setIsGeneratingSummary(true);
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      
      const parts: any[] = [
        {
          text: `Zadanie: odczytaj i zinterpretuj treść załączników przy użyciu OCR dla PDF/obrazów oraz analizy metadanych. Następnie wygeneruj wyłącznie tekst zawierający:
Numer szkody: <numer szkody z sekcji "Dane wejściowe">
Temat: <temat maila>
Nadawca: <adres e-mail nadawcy>
Data wpływu: <wstaw dokładnie wartość z pola "Data otrzymania maila" poniżej, nie zmieniaj jej>
Załączniki:
<nazwa_pliku> — <etykieta>

Kategorie załączników (jedna etykieta na plik; wybierz najlepszą):
dowód rejestracyjny
oświadczenie sprawcy
zdjęcia pojazdu
zdjęcia uszkodzeń
zdjęcie miejsca
faktura/rachunek
kosztorys
decyzja
pismo 30
protokół policji
polisa ubezpieczeniowa
odwołanie/reklamacja
dyspozycja wypłaty
upoważnienie/cesja
inne

Reguły klasyfikacji (stosuj w tej kolejności):
1. Użyj OCR i wyszukaj typowe frazy: "dowód rejestracyjny", "oświadczenie", "faktura", "FV", "kosztorys", "decyzja", "pismo 30", "protokół", "polisa", "dyspozycja wypłaty", "upoważnienie", "cesja".
2. Dla obrazów: 
   - Jeżeli obraz przedstawia otoczenie, drogę, skrzyżowanie lub ogólny widok miejsca zdarzenia -> "zdjęcie miejsca".
   - Jeżeli obraz to fotografia pojazdu (cała sylwetka) -> "zdjęcia pojazdu".
   - Jeżeli obraz to zbliżenie na konkretne uszkodzenia -> "zdjęcia uszkodzeń".
3. Jeżeli plik ma strukturę faktury (numery, kwoty, NIP, słowo "Faktura"/"FV") -> "faktura/rachunek".
4. Jeśli dokument ma formalny nagłówek/uwagi decyzyjne słowa typu "DECYZJA" -> "decyzja".
5. Sprawdzaj nazwy plików i metadane (np. nazwa zawiera "oswiadczenie" -> "oświadczenie sprawcy", "dyspozycja" -> "dyspozycja wypłaty", "upowaznienie" lub "cesja" -> "upoważnienie/cesja").
6. Jeśli nie da się rozpoznać jednoznacznie -> "inne".

Ważne: Pole "Data wpływu" MUSI być identyczne z "Data otrzymania maila" z sekcji "Dane wejściowe". Pod żadnym pozorem nie szukaj innej daty w załącznikach.

Wyjście: wyłącznie czysty tekst w poniższym formacie (bez żadnych dodatkowych wyjaśnień):
Numer szkody: <…>
Temat: <…>
Nadawca: <…>
Data wpływu: <…>
Załączniki:
<nazwa_pliku> — <etykieta>

Dane wejściowe:
Numer szkody: ${claimNumber}
Temat: ${data.subject || ''}
Nadawca: ${data.senderEmail || data.senderName || ''}
Data otrzymania maila: ${formatDate(data.receivedTime)}
`
        }
      ];

      // Add attachments to parts for multimodal analysis
      // Limit to first 10 attachments to avoid token limits
      const attachmentsToProcess = data.attachments.slice(0, 10);
      
      for (const att of attachmentsToProcess) {
        const ext = att.fileName.split('.').pop()?.toLowerCase();
        const isImage = ['jpg', 'jpeg', 'png', 'webp'].includes(ext || '');
        const isPdf = ext === 'pdf';

        if (isImage || isPdf) {
          // Convert Uint8Array to base64
          const base64 = btoa(
            new Uint8Array(att.content).reduce(
              (data, byte) => data + String.fromCharCode(byte),
              ''
            )
          );
          
          parts.push({
            inlineData: {
              data: base64,
              mimeType: isPdf ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`
            }
          });
          
          // Also add filename as text context for this part
          parts.push({ text: `Plik: ${att.fileName}` });
        } else {
          // For other files, just provide the name
          parts.push({ text: `Plik (tylko nazwa): ${att.fileName}` });
        }
      }

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts }],
      });

      setSummary(response.text || "Błąd generowania podsumowania.");
    } catch (err) {
      console.error('Error generating summary:', err);
      setSummary("Wystąpił błąd podczas analizy załączników przez AI.");
    } finally {
      setIsGeneratingSummary(false);
    }
  };

  const processFile = async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.msg')) {
      setError('Please upload a valid .msg file');
      return;
    }

    setIsLoading(true);
    setError(null);
    setSummary(null);

    try {
      const arrayBuffer = await file.arrayBuffer();
      const reader = new MsgReader(arrayBuffer);
      const data = reader.getFileData();

      if (!data) {
        throw new Error('Failed to parse MSG file data');
      }

      // Map msgreader data to our interface
      const rawAttachments = (Array.isArray(data.attachments) ? data.attachments : []).filter(Boolean);
      
      const attachments: Attachment[] = rawAttachments
        .map((att: any) => {
          const fullAttachment = reader.getAttachment(att);
          return {
            fileName: fullAttachment.fileName || fullAttachment.name || att.fileName || att.name || 'unnamed_attachment',
            content: fullAttachment.content || att.content || new Uint8Array(0),
            extension: fullAttachment.extension || att.extension
          };
        })
        .filter(att => {
          const name = att.fileName.toLowerCase();
          const isOutlookPng = name.endsWith('.png') && name.includes('outlook');
          return !isOutlookPng;
        });

      const extractDateFromHeaders = (headers?: string) => {
        if (!headers) return null;
        const match = headers.match(/^Date:\s*(.*)$/m);
        return match ? match[1] : null;
      };

      const parsedData: EmailData = {
        subject: data.subject,
        senderName: data.senderName,
        senderEmail: data.senderEmail,
        body: data.body,
        bodyHTML: data.bodyHTML,
        receivedTime: data.messageDate || extractDateFromHeaders(data.headers) || data.creationTime,
        attachments: attachments
      };

      setEmailData(parsedData);
      // Automatically generate summary
      generateSummary(parsedData);
    } catch (err) {
      console.error('Error parsing MSG file:', err);
      setError('Failed to parse the email file. It might be corrupted or in an unsupported format.');
    } finally {
      setIsLoading(false);
    }
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
  };

  const downloadAttachment = (att: Attachment) => {
    const blob = new Blob([att.content]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = () => {
    if (summary) {
      navigator.clipboard.writeText(summary);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const reset = () => {
    setEmailData(null);
    setError(null);
    setSummary(null);
  };

  return (
    <div className="min-h-screen bg-[#F5F5F7] text-[#1D1D1F] font-sans p-4 md:p-8">
      <div className="max-w-4xl mx-auto">
        {/* Header */}
        <header className="mb-8 flex justify-between items-end">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">MSG Extractor & AI Analyzer</h1>
            <p className="text-[#86868B] mt-1">Extract attachments and classify them using AI</p>
          </div>
          {emailData && (
            <button 
              onClick={reset}
              className="text-sm font-medium text-[#0066CC] hover:underline flex items-center gap-1"
            >
              <X size={14} />
              Clear
            </button>
          )}
        </header>

        <main>
          <AnimatePresence mode="wait">
            {!emailData ? (
              <motion.div
                key="upload"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="relative"
              >
                <div
                  onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                  className={cn(
                    "relative group cursor-pointer border-2 border-dashed rounded-3xl p-12 transition-all duration-300 flex flex-col items-center justify-center min-h-[400px]",
                    isDragging 
                      ? "border-[#0066CC] bg-[#0066CC]/5 scale-[1.02]" 
                      : "border-[#D2D2D7] bg-white hover:border-[#86868B]"
                  )}
                  onClick={() => document.getElementById('file-input')?.click()}
                >
                  <input
                    id="file-input"
                    type="file"
                    accept=".msg"
                    className="hidden"
                    onChange={onFileChange}
                  />
                  
                  <div className={cn(
                    "w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-transform duration-500 group-hover:scale-110",
                    isDragging ? "bg-[#0066CC] text-white" : "bg-[#F5F5F7] text-[#86868B]"
                  )}>
                    <Upload size={32} />
                  </div>

                  <h2 className="text-xl font-medium mb-2">
                    {isLoading ? "Processing..." : "Drop your .msg file here"}
                  </h2>
                  <p className="text-[#86868B] text-center max-w-xs">
                    or click to browse your computer for an Outlook message file
                  </p>

                  {isLoading && (
                    <div className="absolute inset-0 bg-white/50 backdrop-blur-sm rounded-3xl flex items-center justify-center">
                      <div className="flex flex-col items-center">
                        <div className="w-12 h-12 border-4 border-[#0066CC] border-t-transparent rounded-full animate-spin mb-4" />
                        <p className="font-medium">Parsing email data...</p>
                      </div>
                    </div>
                  )}
                </div>

                {error && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-4 p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600"
                  >
                    <AlertCircle size={20} />
                    <p className="text-sm font-medium">{error}</p>
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="results"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="space-y-6"
              >
                {/* AI Summary Card */}
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-[#D2D2D7]/30 overflow-hidden relative">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold uppercase tracking-wider text-[#86868B] flex items-center gap-2">
                      <Check size={16} className="text-emerald-500" />
                      AI Analysis Summary
                    </h3>
                    {summary && (
                      <div className="flex items-center gap-2">
                        <button 
                          onClick={downloadExcel}
                          className="p-2 hover:bg-[#F5F5F7] rounded-lg transition-colors text-[#86868B] hover:text-[#1D1D1F]"
                          title="Download Excel"
                        >
                          <Download size={18} />
                        </button>
                        <button 
                          onClick={copyToClipboard}
                          className="p-2 hover:bg-[#F5F5F7] rounded-lg transition-colors text-[#86868B] hover:text-[#1D1D1F]"
                          title="Copy to clipboard"
                        >
                          {copied ? <Check size={18} className="text-emerald-500" /> : <Copy size={18} />}
                        </button>
                      </div>
                    )}
                  </div>

                  <div className="min-h-[100px] bg-[#F5F5F7] rounded-2xl p-5 font-mono text-sm leading-relaxed whitespace-pre-wrap relative">
                    {isGeneratingSummary ? (
                      <div className="flex flex-col items-center justify-center py-8 space-y-3">
                        <div className="w-6 h-6 border-2 border-[#0066CC] border-t-transparent rounded-full animate-spin" />
                        <p className="text-[#86868B] animate-pulse">AI is analyzing attachments...</p>
                      </div>
                    ) : (
                      summary || "Waiting for analysis..."
                    )}
                  </div>
                </div>

                {/* Email Info Card */}
                <div className="bg-white rounded-3xl p-6 shadow-sm border border-[#D2D2D7]/30">
                  <div className="flex items-start gap-4 mb-6">
                    <div className="w-12 h-12 bg-[#F5F5F7] rounded-xl flex items-center justify-center text-[#1D1D1F] shrink-0">
                      <Mail size={24} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h2 className="text-xl font-semibold leading-tight truncate">
                        {emailData.subject || '(No Subject)'}
                      </h2>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-sm text-[#86868B]">
                        <div className="flex items-center gap-1.5">
                          <User size={14} />
                          <span>{emailData.senderName || emailData.senderEmail || 'Unknown Sender'}</span>
                        </div>
                        {emailData.receivedTime && (
                          <div className="flex items-center gap-1.5">
                            <Calendar size={14} />
                            <span>{formatDate(emailData.receivedTime)}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Attachments Section */}
                  <div className="border-t border-[#F5F5F7] pt-6">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-sm font-semibold uppercase tracking-wider text-[#86868B] flex items-center gap-2">
                        <Paperclip size={16} />
                        Attachments ({emailData.attachments?.length || 0})
                      </h3>
                    </div>

                    {(emailData.attachments?.length || 0) > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {emailData.attachments.map((att, idx) => (
                          <motion.div
                            key={idx}
                            initial={{ opacity: 0, scale: 0.95 }}
                            animate={{ opacity: 1, scale: 1 }}
                            transition={{ delay: idx * 0.05 }}
                            className="group flex items-center justify-between p-4 bg-[#F5F5F7] hover:bg-[#E8E8ED] rounded-2xl transition-colors"
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center text-[#0066CC] shadow-sm">
                                <FileText size={20} />
                              </div>
                              <div className="min-w-0">
                                <p className="text-sm font-medium truncate pr-2">
                                  {att.fileName}
                                </p>
                                <p className="text-[10px] text-[#86868B] uppercase font-bold tracking-tight">
                                  {((att.content?.length || 0) / 1024).toFixed(1)} KB
                                </p>
                              </div>
                            </div>
                            <button
                              onClick={() => downloadAttachment(att)}
                              className="w-10 h-10 rounded-full flex items-center justify-center bg-white text-[#1D1D1F] shadow-sm hover:bg-[#0066CC] hover:text-white transition-all active:scale-95"
                              title="Download"
                            >
                              <Download size={18} />
                            </button>
                          </motion.div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-center py-8 bg-[#F5F5F7] rounded-2xl border border-dashed border-[#D2D2D7]">
                        <p className="text-[#86868B] text-sm italic">No attachments found in this email.</p>
                      </div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>

        <footer className="mt-12 text-center text-[12px] text-[#86868B]">
          <p>Privacy focused: All processing happens locally or via secure AI analysis. Your files are not stored permanently.</p>
        </footer>
      </div>

      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: #D2D2D7;
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: #86868B;
        }
      `}</style>
    </div>
  );
}
