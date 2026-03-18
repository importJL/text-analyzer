import { useState, useCallback, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import './App.css';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface HighlightedText {
  text: string;
  highlights: {
    phrase: string;
    reason: string;
    importance: 'high' | 'medium' | 'low';
  }[];
}

function App() {
  const [inputText, setInputText] = useState('');
  const [analyzedResult, setAnalyzedResult] = useState<HighlightedText | null>(null);
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
          model: 'openai/gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are a text analysis expert. Analyze the provided text and identify key words and phrases that the reader should focus on. For each identified phrase, explain why it's important.

Return your response as a JSON object with this exact structure:
{
  "highlights": [
    {
      "phrase": "exact phrase from the text",
      "reason": "brief explanation of why this is important",
      "importance": "high" | "medium" | "low"
    }
  ]
}

Guidelines:
- Identify 5-15 key phrases depending on text length
- Include main concepts, critical terms, action items, and important conclusions
- The "phrase" must be an EXACT substring from the original text
- Mark truly critical information as "high", supporting concepts as "medium", and supplementary details as "low"
- Return ONLY the JSON object, no additional text`
            },
            {
              role: 'user',
              content: `Analyze this text and identify key phrases to highlight:\n\n${inputText}`
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
        text: inputText,
        highlights: parsed.highlights || []
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to analyze text');
    } finally {
      setIsLoading(false);
    }
  };

  const renderHighlightedText = () => {
    if (!analyzedResult) return null;

    const { text, highlights } = analyzedResult;

    // Sort highlights by position in text (first occurrence)
    const sortedHighlights = [...highlights].sort((a, b) => {
      const posA = text.toLowerCase().indexOf(a.phrase.toLowerCase());
      const posB = text.toLowerCase().indexOf(b.phrase.toLowerCase());
      return posA - posB;
    });

    // Build segments with highlighting
    let segments: { text: string; highlight?: typeof highlights[0] }[] = [];
    let currentIndex = 0;
    const usedRanges: { start: number; end: number }[] = [];

    for (const highlight of sortedHighlights) {
      const phraseIndex = text.toLowerCase().indexOf(highlight.phrase.toLowerCase(), currentIndex);
      if (phraseIndex === -1) continue;

      // Check for overlapping
      const overlaps = usedRanges.some(
        range => !(phraseIndex >= range.end || phraseIndex + highlight.phrase.length <= range.start)
      );
      if (overlaps) continue;

      // Add text before highlight
      if (phraseIndex > currentIndex) {
        segments.push({ text: text.slice(currentIndex, phraseIndex) });
      }

      // Add highlighted segment
      segments.push({
        text: text.slice(phraseIndex, phraseIndex + highlight.phrase.length),
        highlight
      });

      usedRanges.push({ start: phraseIndex, end: phraseIndex + highlight.phrase.length });
      currentIndex = phraseIndex + highlight.phrase.length;
    }

    // Add remaining text
    if (currentIndex < text.length) {
      segments.push({ text: text.slice(currentIndex) });
    }

    return (
      <div className="highlighted-text">
        {segments.map((segment, index) => {
          if (segment.highlight) {
            const colorClass =
              segment.highlight.importance === 'high' ? 'highlight-high' :
              segment.highlight.importance === 'medium' ? 'highlight-medium' : 'highlight-low';

            return (
              <span
                key={index}
                className={`highlight ${colorClass}`}
                title={segment.highlight.reason}
              >
                {segment.text}
              </span>
            );
          }
          return <span key={index}>{segment.text}</span>;
        })}
      </div>
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

            <div className="legend">
              <span className="legend-item">
                <span className="legend-dot high"></span>
                High Importance
              </span>
              <span className="legend-item">
                <span className="legend-dot medium"></span>
                Medium Importance
              </span>
              <span className="legend-item">
                <span className="legend-dot low"></span>
                Low Importance
              </span>
            </div>

            <div className="result-content">
              {renderHighlightedText()}
            </div>

            <div className="highlights-list">
              <h3>Key Phrases Identified</h3>
              {analyzedResult.highlights.map((item, index) => (
                <div key={index} className={`highlight-item ${item.importance}`}>
                  <div className="highlight-phrase">"{item.phrase}"</div>
                  <div className="highlight-reason">{item.reason}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
