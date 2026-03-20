import { useState, useCallback, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import './App.css';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface FormattedResult {
  formatted_text: string;
  rationale: string;
}

function App() {
  const [inputText, setInputText] = useState('');
  const [analyzedResult, setAnalyzedResult] = useState<FormattedResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const extractTextFromPDF = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = '';

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');
      fullText += pageText + '\n';
    }

    return fullText.trim();
  };

  const extractTextFromDOCX = async (file: File): Promise<string> => {
    const arrayBuffer = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer });
    return result.value.trim();
  };

  const handleFileUpload = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setIsExtracting(true);
    setError(null);
    setFileName(file.name);
    setAnalyzedResult(null);

    try {
      let extractedText = '';
      const fileType = file.name.toLowerCase();

      if (fileType.endsWith('.pdf')) {
        extractedText = await extractTextFromPDF(file);
      } else if (fileType.endsWith('.docx') || fileType.endsWith('.doc')) {
        extractedText = await extractTextFromDOCX(file);
      } else {
        throw new Error('Unsupported file type. Please upload a PDF or DOCX file.');
      }

      setInputText(extractedText);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract text from file');
    } finally {
      setIsExtracting(false);
    }
  }, []);

  const analyzeText = async () => {
    if (!inputText.trim()) {
      setError('Please enter or upload some text to analyze');
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${import.meta.env.VITE_OPENROUTER_API_KEY}`,
          'HTTP-Referer': window.location.origin,
          'X-Title': 'Text Analyzer'
        },
        body: JSON.stringify({
          model: import.meta.env.VITE_OPEN_ROUTER_MODEL,
          messages: [
            {
              role: 'system',
              content: `You are critical thinking analyst proficient in understanding all types of text. You can adapt your persona and experties per contextual knowledge of a provided text so to answer the user ask as appropriate as possible.`
            },
            {
              role: 'user',
              content: `Bold and highlight certain words and phrases that you believe are useful for the reader to retain in memory with your understanding of the domain knowledge and context of the content provided.

In addition to the task above, explain your rationale as to why those words / phrases were bold / highlighted.

To do the above, you must follow the guidelines below:
- Output the exact text as was inputted and provided to you with proper HTML & CSS tags to represent the bold / highlighting.
- Do not reproduce differently or summarize the text that was provided.
- Your response output should be in JSON format of the following: {"formatted_text": <original text with additional tags to represent bold / highlighting>, "rationale": <rationale for the bold / highlighting>}\n\nText to analyze:\n${inputText}`
            }
          ],
          temperature: 0.3
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error?.message || `API request failed: ${response.status}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;

      if (!content) {
        throw new Error('No response from AI');
      }

      // Parse JSON response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('Invalid response format');
      }

      const parsed = JSON.parse(jsonMatch[0]);
      setAnalyzedResult({
        formatted_text: parsed.formatted_text || inputText,
        rationale: parsed.rationale || ''
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze text');
    } finally {
      setIsLoading(false);
    }
  };

  const renderFormattedText = () => {
    if (!analyzedResult) return null;

    const { formatted_text } = analyzedResult;

    return (
      <div 
        className="formatted-text"
        dangerouslySetInnerHTML={{ __html: formatted_text }}
      />
    );
  };

  const clearAll = () => {
    setInputText('');
    setAnalyzedResult(null);
    setError(null);
    setFileName(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="app">
      <header className="header">
        <h1>Text Analyzer</h1>
        <p>Import a document or paste text to identify key phrases</p>
      </header>

      <main className="main">
        <div className="input-section">
          <div className="file-upload">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={handleFileUpload}
              id="file-input"
              className="file-input"
            />
            <label htmlFor="file-input" className="file-label">
              <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="17 8 12 3 7 8"/>
                <line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              <span>{isExtracting ? 'Extracting...' : 'Upload PDF or DOCX'}</span>
            </label>
            {fileName && <span className="file-name">{fileName}</span>}
          </div>

          <div className="divider">
            <span>or paste your text below</span>
          </div>

          <textarea
            className="text-input"
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              setAnalyzedResult(null);
            }}
            placeholder="Paste or type your text here..."
            rows={12}
          />

          <div className="button-group">
            <button
              className="analyze-btn"
              onClick={analyzeText}
              disabled={isLoading || !inputText.trim()}
            >
              {isLoading ? (
                <>
                  <span className="spinner"></span>
                  Analyzing...
                </>
              ) : (
                <>
                  <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="11" cy="11" r="8"/>
                    <path d="m21 21-4.3-4.3"/>
                  </svg>
                  Analyze Text
                </>
              )}
            </button>
            <button className="clear-btn" onClick={clearAll}>
              Clear
            </button>
          </div>

          {error && <div className="error">{error}</div>}
        </div>

        {analyzedResult && (
          <div className="results-section">
            <h2>Analysis Results</h2>

            <div className="result-header">
              <span className="result-label">Formatted Text</span>
              <div className="tooltip-container">
                <button className="info-icon" title="View rationale">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M12 16v-4"/>
                    <path d="M12 8h.01"/>
                  </svg>
                </button>
                <div className="tooltip-content">
                  <div className="tooltip-title">Rationale</div>
                  <div className="tooltip-text">{analyzedResult.rationale}</div>
                </div>
              </div>
            </div>

            <div className="result-content">
              {renderFormattedText()}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
