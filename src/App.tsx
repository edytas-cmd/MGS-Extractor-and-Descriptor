import React, { useState, useCallback, useEffect } from 'react';
import MsgReader from '@kenjiuno/msgreader';
import { Upload, FileText, Download, Mail, User, Calendar, Paperclip, X, AlertCircle, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { GoogleGenAI } from "@google/genai";
import heic2any from 'heic2any';
import * as XLSX from 'xlsx';

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface Attachment {
  fileName: string;
  content: Uint8Array;
  dataId?: number;
  extension?: string;
  isUnreadable?: boolean;
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

interface AnalysisJob {
  id: string;
  fileName: string;
  emailData: EmailData | null;
  summary: string | null;
  status: 'parsing' | 'analyzing' | 'completed' | 'error';
  error: string | null;
  isGenerating: boolean;
}

export default function App() {
  const [jobs, setJobs] = useState<AnalysisJob[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [copied, setCopied] = useState(false);

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const downloadExcel = () => {
    const completedJobs = jobs.filter(j => j.summary && j.status === 'completed');
    if (completedJobs.length === 0) return;

    const allData = completedJobs.map(job => {
      const summary = job.summary!;
      
      if (summary === "Brak numeru szkody w tytule maila") {
        return {
          'Numer szkody': 'BRAK',
          'Temat': job.emailData?.subject || job.fileName,
          'Nadawca': job.emailData?.senderEmail || '',
          'Data wpływu': job.emailData?.receivedTime ? formatDate(job.emailData.receivedTime) : '',
          'Załączniki': 'N/A (Brak numeru szkody)'
        };
      }

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
          if (trimmedLine === "Załącznikiem jest e-mail") {
            zalaczniki.push(trimmedLine);
          } else {
            zalaczniki.push(`• ${trimmedLine}`);
          }
        }
      });

      const zalacznikiStr = zalaczniki.join('\n');

      // Parse claim number
      let numerSzkody = '';
      const numerSzkodyLine = lines.find(l => l.trim().startsWith('Numer szkody:'));
      if (numerSzkodyLine) {
        numerSzkody = numerSzkodyLine.replace('Numer szkody:', '').trim();
      }

      return {
        'Numer szkody': numerSzkody,
        'Temat': temat || job.emailData?.subject || '',
        'Nadawca': nadawca || job.emailData?.senderEmail || '',
        'Data wpływu': dataWplywu || (job.emailData?.receivedTime ? formatDate(job.emailData.receivedTime) : ''),
        'Załączniki': zalacznikiStr
      };
    });

    const worksheet = XLSX.utils.json_to_sheet(allData);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Analiza");

    const wscols = [
      { wch: 25 }, // Numer szkody
      { wch: 40 }, // Temat
      { wch: 30 }, // Nadawca
      { wch: 20 }, // Data wpływu
      { wch: 50 }, // Załączniki
    ];
    worksheet['!cols'] = wscols;

    XLSX.writeFile(workbook, `analiza_zbiorcza_${new Date().getTime()}.xlsx`);
  };

  const generateSummary = async (jobId: string, data: EmailData) => {
    // Check for claim number in subject
    const claimNumberRegex = /[A-Z]{2,3}\d+-\d{5}\/\d{2}-\d{2}/;
    const match = data.subject?.match(claimNumberRegex);
    
    if (!match) {
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, summary: "Brak numeru szkody w tytule maila", status: 'completed', isGenerating: false } : j));
      return;
    }

    const claimNumber = match[0];
    setJobs(prev => prev.map(j => j.id === jobId ? { ...j, isGenerating: true, status: 'analyzing' } : j));
    
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
oświadczenie
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
5. Sprawdzaj nazwy plików i metadane (np. nazwa zawiera "oswiadczenie" -> "oświadczenie", "dyspozycja" -> "dyspozycja wypłaty", "upowaznienie" lub "cesja" -> "upoważnienie/cesja").
6. Jeśli plik jest oznaczony jako (nieczytelny/błąd odczytu) -> "Nieznany załącznik".
7. Jeśli nie da się rozpoznać jednoznacznie -> "inne".

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

      // Prioritize PDF files and process more than 10 attachments
      const sortedAttachments = [...data.attachments].sort((a, b) => {
        const extA = a.fileName.split('.').pop()?.toLowerCase();
        const extB = b.fileName.split('.').pop()?.toLowerCase();
        if (extA === 'pdf' && extB !== 'pdf') return -1;
        if (extA !== 'pdf' && extB === 'pdf') return 1;
        return 0;
      });

      const attachmentsToProcess = sortedAttachments;
      
      for (const att of attachmentsToProcess) {
        if (att.isUnreadable) {
          parts.push({ text: `Plik (nieczytelny/błąd odczytu): ${att.fileName}` });
          continue;
        }

        const ext = att.fileName.split('.').pop()?.toLowerCase();
        const isImage = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'].includes(ext || '');
        const isPdf = ext === 'pdf';

        if (isImage || isPdf) {
          let base64 = '';
          let mimeType = isPdf ? 'application/pdf' : `image/jpeg`;

          if (isImage) {
            try {
              let blob = new Blob([att.content]);
              
              // Handle HEIC/HEIF conversion
              if (ext === 'heic' || ext === 'heif') {
                const converted = await heic2any({ blob, toType: "image/jpeg", quality: 0.7 });
                blob = Array.isArray(converted) ? converted[0] : converted;
              }

              // Create thumbnail (max 200px)
              base64 = await new Promise<string>((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                  const canvas = document.createElement('canvas');
                  const MAX_SIZE = 200;
                  let width = img.width;
                  let height = img.height;

                  if (width > height) {
                    if (width > MAX_SIZE) {
                      height *= MAX_SIZE / width;
                      width = MAX_SIZE;
                    }
                  } else {
                    if (height > MAX_SIZE) {
                      width *= MAX_SIZE / height;
                      height = MAX_SIZE;
                    }
                  }

                  canvas.width = width;
                  canvas.height = height;
                  const ctx = canvas.getContext('2d');
                  ctx?.drawImage(img, 0, 0, width, height);
                  resolve(canvas.toDataURL('image/jpeg', 0.8).split(',')[1]);
                  URL.revokeObjectURL(img.src);
                };
                img.onerror = reject;
                img.src = URL.createObjectURL(blob);
              });
            } catch (err) {
              console.error(`Error processing image ${att.fileName}:`, err);
              parts.push({ text: `Plik (błąd przetwarzania obrazu): ${att.fileName}` });
              continue;
            }
          } else {
            // For PDFs, use existing FileReader method
            base64 = await new Promise<string>((resolve) => {
              const blob = new Blob([att.content]);
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result as string;
                resolve(result.split(',')[1]);
              };
              reader.readAsDataURL(blob);
            });
          }
          
          parts.push({
            inlineData: {
              data: base64,
              mimeType: mimeType
            }
          });
          
          parts.push({ text: `Plik: ${att.fileName}` });
        } else {
          parts.push({ text: `Plik (tylko nazwa): ${att.fileName}` });
        }
      }

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ parts }],
      });

      let finalSummary = response.text || "Błąd generowania podsumowania.";
      
      // Check if any attachment is a .msg file
      const hasMsgAttachment = data.attachments.some(att => 
        att.fileName.toLowerCase().endsWith('.msg')
      );

      if (hasMsgAttachment) {
        finalSummary += "\n\nZałącznikiem jest e-mail";
      }

      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, summary: finalSummary, status: 'completed', isGenerating: false } : j));
    } catch (err) {
      console.error('Error generating summary:', err);
      setJobs(prev => prev.map(j => j.id === jobId ? { ...j, summary: "Wystąpił błąd podczas analizy załączników przez AI.", status: 'error', isGenerating: false } : j));
    }
  };

  const processFiles = async (files: FileList | File[]) => {
    const fileArray = Array.from(files).filter(f => f.name.toLowerCase().endsWith('.msg'));
    
    if (fileArray.length === 0) return;

    const newJobs: AnalysisJob[] = fileArray.map(file => ({
      id: Math.random().toString(36).substring(7),
      fileName: file.name,
      emailData: null,
      summary: null,
      status: 'parsing',
      error: null,
      isGenerating: false
    }));

    setJobs(prev => [...prev, ...newJobs]);

    fileArray.forEach(async (file, index) => {
      const jobId = newJobs[index].id;
      try {
        const arrayBuffer = await file.arrayBuffer();
        
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
          throw new Error('Plik jest pusty lub nie mógł zostać odczytany.');
        }

        // Convert to Uint8Array which is often more stable for OLE parsers
        const uint8Array = new Uint8Array(arrayBuffer);

        // Basic OLE header check (D0 CF 11 E0 A1 B1 1A E1)
        if (uint8Array.length < 8 || 
            uint8Array[0] !== 0xD0 || uint8Array[1] !== 0xCF || 
            uint8Array[2] !== 0x11 || uint8Array[3] !== 0xE0) {
          throw new Error('Nieprawidłowy format pliku MSG (brak nagłówka OLE).');
        }

        let reader;
        let data;
        try {
          reader = new MsgReader(uint8Array);
          data = reader.getFileData();
        } catch (parseErr: any) {
          console.error('MsgReader internal error:', parseErr);
          throw new Error(`Błąd wewnętrzny podczas analizy struktury pliku: ${parseErr.message || 'Nieprawidłowa długość tablicy lub uszkodzony format'}`);
        }

        if (!data) throw new Error('Nie udało się wyodrębnić danych z pliku MSG.');

        const rawAttachments = (Array.isArray(data.attachments) ? data.attachments : []).filter(Boolean);
        
        const attachments: Attachment[] = rawAttachments
          .map((att: any) => {
            try {
              const fullAttachment = reader.getAttachment(att);
              return {
                fileName: fullAttachment.fileName || fullAttachment.name || att.fileName || att.name || 'unnamed_attachment',
                content: fullAttachment.content || att.content || new Uint8Array(0),
                extension: fullAttachment.extension || att.extension,
                isUnreadable: false
              };
            } catch (e) {
              console.error('Error extracting attachment:', e);
              return {
                fileName: att.fileName || att.name || 'unnamed_attachment',
                content: new Uint8Array(0),
                isUnreadable: true
              };
            }
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

        if (attachments.length === 0) {
          setJobs(prev => prev.filter(j => j.id !== jobId));
          return;
        }

        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, emailData: parsedData, status: 'analyzing' } : j));
        generateSummary(jobId, parsedData);
      } catch (err) {
        console.error('Error parsing MSG file:', err);
        setJobs(prev => prev.map(j => j.id === jobId ? { ...j, status: 'error', error: 'Failed to parse the email file.' } : j));
      }
    });
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files) processFiles(e.dataTransfer.files);
  }, []);

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
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

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const reset = () => {
    setJobs([]);
  };

  const removeJob = (id: string) => {
    setJobs(prev => prev.filter(j => j.id !== id));
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
          {jobs.length > 0 && (
            <div className="flex items-center gap-4">
              <button 
                onClick={downloadExcel}
                className="text-sm font-medium text-[#0066CC] hover:underline flex items-center gap-1"
              >
                <Download size={14} />
                Export All
              </button>
              <button 
                onClick={reset}
                className="text-sm font-medium text-[#FF3B30] hover:underline flex items-center gap-1"
              >
                <X size={14} />
                Clear All
              </button>
            </div>
          )}
        </header>

        <main>
          <div className="space-y-8">
            {/* Upload Section */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="relative"
            >
              <div
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={onDrop}
                className={cn(
                  "relative group cursor-pointer border-2 border-dashed rounded-3xl p-8 transition-all duration-300 flex flex-col items-center justify-center min-h-[200px]",
                  isDragging 
                    ? "border-[#0066CC] bg-[#0066CC]/5 scale-[1.01]" 
                    : "border-[#D2D2D7] bg-white hover:border-[#86868B]"
                )}
                onClick={() => document.getElementById('file-input')?.click()}
              >
                <input
                  id="file-input"
                  type="file"
                  accept=".msg"
                  multiple
                  className="hidden"
                  onChange={onFileChange}
                />
                
                <div className={cn(
                  "w-12 h-12 rounded-xl flex items-center justify-center mb-4 transition-transform duration-500 group-hover:scale-110",
                  isDragging ? "bg-[#0066CC] text-white" : "bg-[#F5F5F7] text-[#86868B]"
                )}>
                  <Upload size={24} />
                </div>

                <h2 className="text-lg font-medium mb-1">
                  Drop your .msg files here
                </h2>
                <p className="text-[#86868B] text-sm text-center">
                  or click to browse. You can select multiple files.
                </p>
              </div>
            </motion.div>

            {/* Jobs List */}
            <div className="space-y-6">
              {jobs.map((job) => (
                <motion.div
                  key={job.id}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="bg-white rounded-3xl shadow-sm border border-[#D2D2D7]/30 overflow-hidden"
                >
                  {/* Job Header */}
                  <div className="bg-[#F5F5F7]/50 px-6 py-3 border-bottom border-[#D2D2D7]/20 flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[#86868B]">
                      <FileText size={16} />
                      <span className="text-xs font-medium truncate max-w-[200px] md:max-w-md">
                        {job.fileName}
                      </span>
                    </div>
                    <button 
                      onClick={() => removeJob(job.id)}
                      className="p-1 hover:bg-[#E8E8ED] rounded-full text-[#86868B] transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </div>

                  <div className="p-6">
                    <AnimatePresence mode="wait">
                      {job.status === 'parsing' ? (
                        <div className="flex flex-col items-center justify-center py-8 space-y-3">
                          <div className="w-6 h-6 border-2 border-[#0066CC] border-t-transparent rounded-full animate-spin" />
                          <p className="text-[#86868B] text-sm">Parsing MSG file...</p>
                        </div>
                      ) : job.status === 'error' ? (
                        <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-center gap-3 text-red-600">
                          <AlertCircle size={20} />
                          <p className="text-sm font-medium">{job.error || 'Wystąpił błąd'}</p>
                        </div>
                      ) : (
                        <div className="space-y-6">
                          {/* AI Summary Section */}
                          <div className="bg-[#F5F5F7] rounded-2xl p-5 relative">
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#86868B]">AI Analysis</h4>
                              {job.summary && !job.isGenerating && (
                                <button 
                                  onClick={() => copyToClipboard(job.summary!)}
                                  className="p-1.5 hover:bg-white rounded-lg transition-colors text-[#86868B] hover:text-[#1D1D1F]"
                                >
                                  {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
                                </button>
                              )}
                            </div>
                            
                            <div className="font-mono text-xs leading-relaxed whitespace-pre-wrap">
                              {job.isGenerating ? (
                                <div className="flex items-center gap-2 py-2">
                                  <div className="w-3 h-3 border-2 border-[#0066CC] border-t-transparent rounded-full animate-spin" />
                                  <span className="text-[#86868B] animate-pulse">Analyzing attachments...</span>
                                </div>
                              ) : (
                                job.summary
                              )}
                            </div>
                          </div>

                          {/* Email Details */}
                          {job.emailData && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#86868B] mb-3">Email Info</h4>
                                <div className="space-y-2">
                                  <p className="text-sm font-semibold text-[#1D1D1F] line-clamp-1">{job.emailData.subject || '(No Subject)'}</p>
                                  <div className="flex items-center gap-2 text-xs text-[#86868B]">
                                    <User size={12} />
                                    <span>{job.emailData.senderName || job.emailData.senderEmail}</span>
                                  </div>
                                  <div className="flex items-center gap-2 text-xs text-[#86868B]">
                                    <Calendar size={12} />
                                    <span>{formatDate(job.emailData.receivedTime)}</span>
                                  </div>
                                </div>
                              </div>

                              <div>
                                <h4 className="text-[10px] font-bold uppercase tracking-widest text-[#86868B] mb-3">
                                  Attachments ({job.emailData.attachments.length})
                                </h4>
                                <div className="max-h-[120px] overflow-y-auto custom-scrollbar pr-2 space-y-2">
                                  {job.emailData.attachments.map((att, idx) => (
                                    <div key={idx} className="flex items-center justify-between p-2 bg-[#F5F5F7] rounded-xl group">
                                      <span className="text-[11px] font-medium truncate flex-1 pr-2">{att.fileName}</span>
                                      <button 
                                        onClick={() => downloadAttachment(att)}
                                        className="p-1.5 bg-white rounded-lg text-[#0066CC] opacity-0 group-hover:opacity-100 transition-opacity"
                                      >
                                        <Download size={12} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </AnimatePresence>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
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
