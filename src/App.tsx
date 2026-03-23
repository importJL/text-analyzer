import { useState, useCallback, useRef } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import mammoth from 'mammoth';
import './App.css';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface FormattedResult {
  formatted_text: string;
  rationale: string;
  summary: string;
}

function App() {
  const [inputText, setInputText] = useState('');
  const [analyzedResult, setAnalyzedResult] = useState<FormattedResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [maxPhrases, setMaxPhrases] = useState<number>(5);
  const [activeTab, setActiveTab] = useState<'highlights' | 'summary'>('highlights');
  const [url, setUrl] = useState('');
  const [isExtractingUrl, setIsExtractingUrl] = useState(false);
  const [proxyStatus, setProxyStatus] = useState<string | null>(null);
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

  // HTTP headers to mimic a real browser - helps bypass anti-bot systems
  const BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.bbc.com/',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9'
  };

  // List of extraction methods to try in order
  // Jina AI is tried first as it works best for news sites like BBC
  const EXTRACTION_METHODS = [
    { 
      name: 'Jina AI Reader', 
      url: (url: string) => `https://r.jina.ai/http://${url.replace(/^https?:\/\//, '')}`,
      isJina: true 
    },
    { 
      name: 'Jina AI HTTPS', 
      url: (url: string) => `https://r.jina.ai/https://${url.replace(/^https?:\/\//, '')}`,
      isJina: true 
    },
    { name: 'CodeTabs Proxy', url: (url: string) => `https://api.codetabs.com/v1/proxy?quest=${url}`, hasHeaders: true },
    { name: 'corsproxy.io', url: (url: string) => `https://corsproxy.io/?${url}`, hasHeaders: true },
    { name: 'allorigins.win', url: (url: string) => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`, hasHeaders: true },
    { name: 'corsproxy.org', url: (url: string) => `https://corsproxy.org/?${url}`, hasHeaders: true }
  ];

  const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  
  // Get random delay between min and max milliseconds
  const getRandomDelay = (min: number = 500, max: number = 1500) => {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  };

  const extractTextFromURL = async (url: string, onMethodAttempt?: (methodName: string) => void): Promise<string> => {
    // Validate URL
    try {
      new URL(url);
    } catch {
      throw new Error('Please enter a valid URL');
    }

    let lastError: Error | null = null;

    // Try each extraction method in order
    for (let attempt = 0; attempt < EXTRACTION_METHODS.length; attempt++) {
      const method = EXTRACTION_METHODS[attempt];
      
      // Notify UI of extraction attempt
      if (onMethodAttempt) {
        onMethodAttempt(method.name);
      }

      // Add small random delay between attempts (except for first)
      if (attempt > 0) {
        await delay(getRandomDelay());
      }

      try {
        let html: string;
        const targetUrl = method.url(url);

        // Build fetch options with appropriate headers
        const fetchOptions: RequestInit = {};
        
        if (method.hasHeaders) {
          fetchOptions.headers = BROWSER_HEADERS;
        }

        const response = await fetch(targetUrl, fetchOptions);
        
        if (!response.ok) {
          throw new Error(`Method ${method.name} returned: ${response.status} ${response.statusText}`);
        }

        if (method.isJina) {
          // Jina AI returns plain text, not HTML
          html = await response.text();
          // Wrap in simple HTML for consistent parsing
          html = `<html><body><pre>${html}</pre></body></html>`;
        } else if (method.name === 'allorigins.win') {
          // allorigins.win returns JSON with the content in a "contents" field
          const data = await response.json();
          if (!data.contents) {
            throw new Error(`Method ${method.name} did not return valid content`);
          }
          html = data.contents;
        } else {
          html = await response.text();
        }

        // Parse HTML and extract text content
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');

        // Remove script, style, and other non-content elements
        const scripts = doc.querySelectorAll('script, style, noscript, iframe, object, embed');
        scripts.forEach(el => el.remove());

        // Get text content from body
        const body = doc.body;
        if (!body) {
          throw new Error('Could not parse HTML content');
        }

        // Extract text and clean up whitespace
        let text = body.textContent || '';
        text = text.replace(/\s+/g, ' ').trim();

        if (!text) {
          throw new Error('No text content found on the page');
        }

        // Success! Return the extracted text
        return text;

      } catch (error) {
        // Store this error and try the next method
        lastError = error instanceof Error ? error : new Error(String(error));
        console.warn(`Method ${method.name} failed:`, lastError.message);
        
        // If this is a network error or 403/500, continue to next method
        // If it's a content parsing error, we might still want to try other methods
        continue;
      }
    }

    // All methods failed
    const attemptedMethods = EXTRACTION_METHODS.map(m => m.name).join(', ');
    throw new Error(
      `Unable to extract text from this URL. The website may be blocking automated access.\n\n` +
      `Attempted methods: ${attemptedMethods}\n\n` +
      `Suggestions:\n` +
      `• Try copy-pasting the text directly\n` +
      `• Try a different source URL\n` +
      `• Some websites (like CNBC, paywalled content) actively block extraction\n` +
      `• Last error: ${lastError?.message || 'Unknown error'}`
    );
  };

  const handleUrlExtract = async () => {
    if (!url.trim()) {
      setError('Please enter a URL');
      return;
    }

    setIsExtractingUrl(true);
    setError(null);
    setAnalyzedResult(null);
    setProxyStatus(null);

    try {
      const extractedText = await extractTextFromURL(url, (methodName) => {
        setProxyStatus(`Trying ${methodName}...`);
      });
      setInputText(extractedText);
      setProxyStatus('Extraction successful!');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to extract text from URL');
      setProxyStatus(null);
    } finally {
      setIsExtractingUrl(false);
    }
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
              content: `Select a maximum of ${maxPhrases} important phrases/words to highlight that you believe are useful for the reader to retain in memory with your understanding of the domain knowledge and context of the content provided.

Assign an importance level (1, 2, or 3) to each highlighted phrase:
- Level 1 (Light Yellow #FFF9C4): Basic important terms the reader should recognize
- Level 2 (Medium Yellow #FFEB3B): Important concepts worth memorizing  
- Level 3 (Dark Yellow #FBC02D): Most critical concepts essential to remember

In addition to the task above, explain your rationale as to why those words / phrases were highlighted.

Also provide a concise summary of the key points from the text.

To do the above, you must follow the guidelines below:
- Output the exact text as was inputted and provided to you with proper HTML & CSS tags to represent the highlighting with different importance levels.
- Do not reproduce differently or summarize the text that was provided.
- Use inline styles for each importance level:
  - Level 1: <span style="background-color: #FFF9C4; font-weight: bold;">phrase</span>
  - Level 2: <span style="background-color: #FFEB3B; font-weight: bold;">phrase</span>
  - Level 3: <span style="background-color: #FBC02D; font-weight: bold;">phrase</span>
- Your response output should be in JSON format of the following: {"formatted_text": <original text with additional tags to represent highlighting>, "rationale": <rationale for the highlighting>, "summary": <concise summary of the key points from the text>}

Text to analyze:
${inputText}`
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
        rationale: parsed.rationale || '',
        summary: parsed.summary || ''
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
    setIsLoading(false);
    setIsExtracting(false);
    setUrl('');
    setIsExtractingUrl(false);
    setProxyStatus(null);
    setActiveTab('highlights');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  // Check if there are highlighted results (contains span tags)
  const hasHighlights = analyzedResult?.formatted_text?.includes('<span');

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

            <div className="url-input-container">
              <span className="url-label">Or enter URL:</span>
              <input
                type="url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="url-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleUrlExtract();
                  }
                }}
              />
              <button
                className="extract-btn"
                onClick={handleUrlExtract}
                disabled={isExtractingUrl || !url.trim()}
              >
                {isExtractingUrl ? (
                  <>
                    <span className="spinner"></span>
                    Extracting...
                  </>
                ) : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="2" y1="12" x2="22" y2="12"/>
                      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>
                    </svg>
                    Extract
                  </>
                )}
              </button>
            </div>
            {proxyStatus && (
              <div className="proxy-status">
                <span className="proxy-spinner"></span>
                {proxyStatus}
              </div>
            )}
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
            <div className="max-phrases-selector">
              <label htmlFor="max-phrases">Max Phrases:</label>
              <select
                id="max-phrases"
                value={maxPhrases}
                onChange={(e) => setMaxPhrases(Number(e.target.value))}
                className="max-phrases-select"
              >
                {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
                  <option key={num} value={num}>{num}</option>
                ))}
              </select>
            </div>
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
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18"/>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/>
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
              </svg>
              Clear All
            </button>
          </div>

          {error && <div className="error">{error}</div>}
        </div>

        {analyzedResult && (
          <div className="results-section">
            <h2>Analysis Results</h2>

            {/* Tab Navigation */}
            <div className="tab-nav">
              <button
                className={`tab-button ${activeTab === 'highlights' ? 'active' : ''}`}
                onClick={() => setActiveTab('highlights')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"/>
                  <path d="M2 17l10 5 10-5"/>
                  <path d="M2 12l10 5 10-5"/>
                </svg>
                Highlights
              </button>
              <button
                className={`tab-button ${activeTab === 'summary' ? 'active' : ''}`}
                onClick={() => setActiveTab('summary')}
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <line x1="10" y1="9" x2="8" y2="9"/>
                </svg>
                Summary
              </button>
            </div>

            {/* Tab Content */}
            <div className="tab-content">
              {activeTab === 'highlights' && (
                <>
                  {/* Importance Level Legend */}
                  {hasHighlights && (
                    <div className="importance-legend">
                      <span className="legend-title">Importance Levels:</span>
                      <div className="legend-items">
                        <span className="legend-item">
                          <span className="legend-dot level-1"></span>
                          <span>Level 1 - Recognize</span>
                        </span>
                        <span className="legend-item">
                          <span className="legend-dot level-2"></span>
                          <span>Level 2 - Memorize</span>
                        </span>
                        <span className="legend-item">
                          <span className="legend-dot level-3"></span>
                          <span>Level 3 - Essential</span>
                        </span>
                      </div>
                    </div>
                  )}

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
                </>
              )}

              {activeTab === 'summary' && analyzedResult.summary && (
                <div className="summary-container">
                  <div className="summary-header">
                    <span className="result-label">Summary</span>
                  </div>
                  <div className="summary-content">
                    {analyzedResult.summary}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
