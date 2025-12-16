import React, { useState, useEffect, useRef } from 'react';

// Get the API URL from environment variable (set at build time)
const API_URL = process.env.REACT_APP_API_URL;

interface ChatMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: Date;
}

type LoadingState = 'idle' | 'thinking' | 'generating-audio';

const VoiceAssistantApp: React.FC = () => {
    const [inputText, setInputText] = useState<string>('');
    const [loadingState, setLoadingState] = useState<LoadingState>('idle');
    const [error, setError] = useState<string | null>(null);
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);

    // Ref to store the current Blob URL for cleanup
    const blobUrlRef = useRef<string | null>(null);
    // Ref to store the audio element for cleanup
    const audioRef = useRef<HTMLAudioElement | null>(null);
    // Ref for auto-scrolling chat history
    const chatContainerRef = useRef<HTMLDivElement | null>(null);

    // Cleanup Blob URL when audio finishes or component unmounts
    useEffect(() => {
        return () => {
            // Cleanup on unmount
            if (blobUrlRef.current) {
                URL.revokeObjectURL(blobUrlRef.current);
                blobUrlRef.current = null;
            }
        };
    }, []);

    // Auto-scroll to bottom when new messages arrive
    useEffect(() => {
        if (chatContainerRef.current) {
            chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
        }
    }, [chatHistory]);

    const isLoading = loadingState !== 'idle';

    const getButtonText = (): string => {
        switch (loadingState) {
            case 'thinking':
                return 'Thinking...';
            case 'generating-audio':
                return 'Generating Audio...';
            default:
                return 'Send';
        }
    };

    const handleSpeak = async (): Promise<void> => {
        // Validate input
        if (!inputText.trim()) {
            setError('Please enter a message.');
            return;
        }

        // Validate API URL is configured
        if (!API_URL) {
            setError('API URL is not configured. Please set REACT_APP_API_URL environment variable.');
            return;
        }

        // Add user message to chat history
        const userMessage: ChatMessage = {
            role: 'user',
            content: inputText.trim(),
            timestamp: new Date(),
        };
        setChatHistory((prev) => [...prev, userMessage]);

        // Clear input immediately for better UX
        const messageToSend = inputText.trim();
        setInputText('');

        // Set loading state and clear previous errors
        setLoadingState('thinking');
        setError(null);

        // Cleanup any previous Blob URL
        if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }

        try {
            // Send POST request to the conversational backend endpoint
            const response = await fetch(
                `${API_URL}/chat`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ text: messageToSend }),
                }
            );

            // Check if the response is successful
            if (!response.ok) {
                throw new Error(`Server error: ${response.status} ${response.statusText}`);
            }

            // Extract and decode the Gemini response from the header
            const geminiResponseBase64 = response.headers.get('X-Gemini-Response');
            if (geminiResponseBase64) {
                try {
                    const decodedResponse = atob(geminiResponseBase64);
                    const assistantMessage: ChatMessage = {
                        role: 'assistant',
                        content: decodedResponse,
                        timestamp: new Date(),
                    };
                    setChatHistory((prev) => [...prev, assistantMessage]);
                } catch (decodeError) {
                    console.error('Failed to decode Gemini response:', decodeError);
                }
            }

            // Update loading state to generating audio
            setLoadingState('generating-audio');

            // Fetch the audio stream as an ArrayBuffer
            const arrayBuffer = await response.arrayBuffer();

            // Convert ArrayBuffer to Blob with audio/mpeg type
            const blob = new Blob([arrayBuffer], { type: 'audio/mpeg' });

            // Create an object URL for the Blob
            const blobUrl = URL.createObjectURL(blob);
            blobUrlRef.current = blobUrl;

            // Create a new HTMLAudioElement
            const audio = new Audio(blobUrl);
            audioRef.current = audio;

            // Add event listener to cleanup Blob URL after audio finishes playing
            audio.addEventListener('ended', () => {
                if (blobUrlRef.current) {
                    URL.revokeObjectURL(blobUrlRef.current);
                    blobUrlRef.current = null;
                }
            });

            // Add error handler for audio playback
            audio.addEventListener('error', () => {
                setError('Failed to play audio.');
                if (blobUrlRef.current) {
                    URL.revokeObjectURL(blobUrlRef.current);
                    blobUrlRef.current = null;
                }
            });

            // Play the audio
            await audio.play();
        } catch (err) {
            // Handle any errors
            const errorMessage = err instanceof Error ? err.message : 'An unexpected error occurred.';
            setError(errorMessage);
        } finally {
            // Always reset loading state
            setLoadingState('idle');
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (e.key === 'Enter' && !e.shiftKey && !isLoading) {
            e.preventDefault();
            handleSpeak();
        }
    };

    return (
        <div className="voice-assistant-container">
            <h1>🎙️ Voice Assistant</h1>

            {/* Chat History Section */}
            {chatHistory.length > 0 && (
                <div className="chat-history" ref={chatContainerRef}>
                    {chatHistory.map((message, index) => (
                        <div
                            key={index}
                            className={`chat-bubble ${message.role === 'user' ? 'user-bubble' : 'assistant-bubble'}`}
                        >
                            <div className="bubble-header">
                                <span className="bubble-role">
                                    {message.role === 'user' ? '👤 You' : '🤖 Assistant'}
                                </span>
                                <span className="bubble-time">
                                    {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            </div>
                            <div className="bubble-content">{message.content}</div>
                        </div>
                    ))}

                    {/* Loading indicator in chat */}
                    {isLoading && (
                        <div className="chat-bubble assistant-bubble loading-bubble">
                            <div className="bubble-header">
                                <span className="bubble-role">🤖 Assistant</span>
                            </div>
                            <div className="bubble-content">
                                <span className="loading-dots">
                                    {loadingState === 'thinking' ? 'Thinking' : 'Generating audio'}
                                    <span className="dot">.</span>
                                    <span className="dot">.</span>
                                    <span className="dot">.</span>
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {error && (
                <div className="error-message">
                    {error}
                </div>
            )}

            <div className="input-section">
                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Type your message... (Press Enter to send)"
                    rows={3}
                    disabled={isLoading}
                    className="text-input"
                />
            </div>

            <div className="button-section">
                <button
                    onClick={handleSpeak}
                    disabled={isLoading}
                    className="speak-button"
                >
                    {getButtonText()}
                </button>
            </div>

            <style>{`
        .voice-assistant-container {
          max-width: 700px;
          margin: 0 auto;
          padding: 2rem;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }

        h1 {
          text-align: center;
          color: #333;
          margin-bottom: 1.5rem;
          font-size: 1.8rem;
        }

        .chat-history {
          flex: 1;
          max-height: 400px;
          overflow-y: auto;
          margin-bottom: 1.5rem;
          padding: 1rem;
          background: linear-gradient(135deg, #f8f9fa 0%, #e9ecef 100%);
          border-radius: 12px;
          border: 1px solid #dee2e6;
        }

        .chat-bubble {
          max-width: 80%;
          padding: 0.75rem 1rem;
          margin-bottom: 0.75rem;
          border-radius: 12px;
          animation: fadeIn 0.3s ease;
        }

        @keyframes fadeIn {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .user-bubble {
          background: linear-gradient(135deg, #007bff, #0056b3);
          color: white;
          margin-left: auto;
          border-bottom-right-radius: 4px;
        }

        .assistant-bubble {
          background: white;
          color: #333;
          margin-right: auto;
          border-bottom-left-radius: 4px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
        }

        .bubble-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.4rem;
          font-size: 0.75rem;
          opacity: 0.8;
        }

        .user-bubble .bubble-header {
          color: rgba(255, 255, 255, 0.9);
        }

        .bubble-role {
          font-weight: 600;
        }

        .bubble-time {
          font-size: 0.7rem;
        }

        .bubble-content {
          line-height: 1.5;
          word-wrap: break-word;
        }

        .loading-bubble {
          background: linear-gradient(90deg, #f0f0f0, #e0e0e0, #f0f0f0);
          background-size: 200% 100%;
          animation: shimmer 1.5s infinite;
        }

        @keyframes shimmer {
          0% { background-position: -200% 0; }
          100% { background-position: 200% 0; }
        }

        .loading-dots {
          display: inline-flex;
          align-items: center;
        }

        .dot {
          animation: bounce 1.4s infinite;
          display: inline-block;
        }

        .dot:nth-child(1) { animation-delay: 0s; }
        .dot:nth-child(2) { animation-delay: 0.2s; }
        .dot:nth-child(3) { animation-delay: 0.4s; }

        @keyframes bounce {
          0%, 60%, 100% { transform: translateY(0); }
          30% { transform: translateY(-4px); }
        }

        .input-section {
          margin-bottom: 1rem;
        }

        .text-input {
          width: 100%;
          padding: 1rem;
          font-size: 1rem;
          border: 2px solid #e0e0e0;
          border-radius: 12px;
          resize: none;
          transition: border-color 0.2s ease, box-shadow 0.2s ease;
          box-sizing: border-box;
          font-family: inherit;
        }

        .text-input:focus {
          outline: none;
          border-color: #007bff;
          box-shadow: 0 0 0 3px rgba(0, 123, 255, 0.1);
        }

        .text-input:disabled {
          background-color: #f5f5f5;
          cursor: not-allowed;
        }

        .button-section {
          text-align: center;
        }

        .speak-button {
          padding: 0.875rem 2.5rem;
          font-size: 1.1rem;
          font-weight: 600;
          color: #fff;
          background: linear-gradient(135deg, #007bff, #0056b3);
          border: none;
          border-radius: 12px;
          cursor: pointer;
          transition: all 0.2s ease;
          min-width: 180px;
        }

        .speak-button:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 6px 20px rgba(0, 123, 255, 0.35);
        }

        .speak-button:active:not(:disabled) {
          transform: translateY(0);
        }

        .speak-button:disabled {
          background: linear-gradient(135deg, #6c757d, #5a6268);
          cursor: not-allowed;
          transform: none;
        }

        .error-message {
          padding: 1rem;
          margin-bottom: 1rem;
          background-color: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
          border-radius: 8px;
          text-align: center;
        }

        /* Scrollbar styling */
        .chat-history::-webkit-scrollbar {
          width: 6px;
        }

        .chat-history::-webkit-scrollbar-track {
          background: transparent;
        }

        .chat-history::-webkit-scrollbar-thumb {
          background: #c0c0c0;
          border-radius: 3px;
        }

        .chat-history::-webkit-scrollbar-thumb:hover {
          background: #a0a0a0;
        }
      `}</style>
        </div>
    );
};

export default VoiceAssistantApp;
