/**
 * Type definitions for the hassemu adapter
 */

/** Adapter configuration from io-package.json native section */
export interface AdapterConfig {
    /** HTTP port for the web server */
    port: number;
    /** IP address to bind the server to (0.0.0.0 = all interfaces) */
    bindAddress: string;
    /** URL to redirect to after authentication */
    visUrl: string;
    /** Whether authentication is required */
    authRequired: boolean;
    /** Username for authentication */
    username: string;
    /** Password for authentication */
    password: string;
    /** Whether mDNS broadcasting is enabled */
    mdnsEnabled: boolean;
    /** Service name for mDNS discovery */
    serviceName: string;
}

/** Session data stored in the sessions map */
export interface SessionData {
    /** Timestamp when the session was created */
    created: number;
}

/** Minimal adapter interface for dependency injection */
export interface AdapterInterface {
    /** Logger interface for adapter logging */
    log: {
        debug: (msg: string) => void;
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    /** Adapter-managed setInterval (auto-cleanup on unload) */
    setInterval: (callback: () => void, ms: number) => any;
    /** Adapter-managed clearInterval */
    clearInterval: (id: any) => void;
}
