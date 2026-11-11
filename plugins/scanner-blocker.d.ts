import type { RequestPlugin } from '../index.js';

export interface ScannerBlockEvent {
    type: 'scanner-path' | 'banned-client';
    /** Present when `type` is `scanner-path`. */
    reason?: 'php-path' | 'scanner-path' | 'sensitive-file';
    clientIp: string | null;
    host: string;
    url: string;
    bannedUntil: number | null;
}

export interface ScannerBlockerOptions {
    windowMs?: number;
    strikeThreshold?: number;
    banDurationMs?: number;
    maxTrackedClients?: number;
    trustProxy?: boolean;
    onBlock?: (event: ScannerBlockEvent) => void;
    now?: () => number;
}

export function createScannerBlocker(options?: ScannerBlockerOptions): RequestPlugin;
