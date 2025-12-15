import React, { useState, useEffect, useRef } from 'react';

// Get the API URL from environment variable (set at build time)
const API_URL = process.env.REACT_APP_API_URL;

const VoiceAssistantApp: React.FC = () => {
    const [inputText, setInputText] = useState<string>('');
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [error, setError] = useState<string | null>(null);

    // Ref to store the current Blob URL for cleanup
    const blobUrlRef = useRef<string | null>(null);
    // Ref to store the audio element for cleanup
    const audioRef = useRef<HTMLAudioElement | null>(null);

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

    const handleSpeak = async (): Promise<void> => {
        // Validate input
        if (!inputText.trim()) {
            setError('Please enter some text to speak.');
            return;
        }

        // Validate API URL is configured
        if (!API_URL) {
            setError('API URL is not configured. Please set REACT_APP_API_URL environment variable.');
            return;
        }

        // Set loading state and clear previous errors
        setIsLoading(true);
        setError(null);

        // Cleanup any previous Blob URL
        if (blobUrlRef.current) {
            URL.revokeObjectURL(blobUrlRef.current);
            blobUrlRef.current = null;
        }

        try {
            // Send POST request to the backend endpoint using environment variable
            const response = await fetch(
                `${API_URL}/generate-audio`,
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ text: inputText }),
                }
            );

            // Check if the response is successful
            if (!response.ok) {
                throw new Error(`Server error: ${response.status} ${response.statusText}`);
            }

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
            // Always set loading to false
            setIsLoading(false);
        }
    };

    return (
        <div className="voice-assistant-container">
            <h1>Voice Assistant</h1>

            <div className="input-section">
                <textarea
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    placeholder="Enter text to convert to speech..."
                    rows={5}
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
                    {isLoading ? 'Speaking...' : 'Speak'}
                </button>
            </div>

            {error && (
                <div className="error-message">
                    {error}
                </div>
            )}

            <style>{`
        .voice-assistant-container {
          max-width: 600px;
          margin: 0 auto;
          padding: 2rem;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
        }

        h1 {
          text-align: center;
          color: #333;
          margin-bottom: 1.5rem;
        }

        .input-section {
          margin-bottom: 1rem;
        }

        .text-input {
          width: 100%;
          padding: 1rem;
          font-size: 1rem;
          border: 2px solid #e0e0e0;
          border-radius: 8px;
          resize: vertical;
          transition: border-color 0.2s ease;
          box-sizing: border-box;
        }

        .text-input:focus {
          outline: none;
          border-color: #007bff;
        }

        .text-input:disabled {
          background-color: #f5f5f5;
          cursor: not-allowed;
        }

        .button-section {
          text-align: center;
          margin-bottom: 1rem;
        }

        .speak-button {
          padding: 0.75rem 2rem;
          font-size: 1.1rem;
          font-weight: 600;
          color: #fff;
          background: linear-gradient(135deg, #007bff, #0056b3);
          border: none;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s ease;
        }

        .speak-button:hover:not(:disabled) {
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(0, 123, 255, 0.4);
        }

        .speak-button:disabled {
          background: linear-gradient(135deg, #6c757d, #5a6268);
          cursor: not-allowed;
          transform: none;
        }

        .error-message {
          padding: 1rem;
          background-color: #f8d7da;
          color: #721c24;
          border: 1px solid #f5c6cb;
          border-radius: 8px;
          text-align: center;
        }
      `}</style>
        </div>
    );
};

export default VoiceAssistantApp;
