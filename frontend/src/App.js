import React, { useState, useEffect } from 'react';
import Auth, { tokenManager } from './Auth';
import Dashboard from './Dashboard';

/**
 * App Component - Main Application Router for Stark HUD v11.0
 * 
 * Handles authentication state and routes between Auth and Dashboard.
 */
const App = () => {
    const [isAuthenticated, setIsAuthenticated] = useState(false);
    const [user, setUser] = useState(null);
    const [isLoading, setIsLoading] = useState(true);

    // Check for existing authentication on mount
    useEffect(() => {
        const checkAuth = () => {
            const token = tokenManager.getToken();
            const savedUser = tokenManager.getUser();

            if (token && savedUser) {
                setIsAuthenticated(true);
                setUser(savedUser);
            }
            setIsLoading(false);
        };

        checkAuth();
    }, []);

    // Handle successful authentication
    const handleAuthSuccess = (userData) => {
        console.log('✅ Authentication successful:', userData);
        setUser(userData);
        setIsAuthenticated(true);
    };

    // Handle logout
    const handleLogout = () => {
        console.log('🚪 Logging out...');
        tokenManager.clearAuth();
        setUser(null);
        setIsAuthenticated(false);
    };

    // Loading state
    if (isLoading) {
        return (
            <div className="min-h-screen bg-black flex items-center justify-center">
                <div className="text-cyan-400 text-lg tracking-widest animate-pulse">
                    INITIALIZING STARK INTERFACE...
                </div>
            </div>
        );
    }

    // Render Auth or Dashboard based on authentication state
    return isAuthenticated ? (
        <Dashboard user={user} onLogout={handleLogout} />
    ) : (
        <Auth onAuthSuccess={handleAuthSuccess} />
    );
};

export default App;
