import React from 'react';
import ReactDOM from 'react-dom/client';
import VoiceAssistantApp from './VoiceAssistantApp';

const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
);

root.render(
    <React.StrictMode>
        <VoiceAssistantApp />
    </React.StrictMode>
);
