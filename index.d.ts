import type { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse, Server as HttpServer, RequestListener } from 'node:http';
import type { Server as HttpsServer, ServerOptions as HttpsServerOptions } from 'node:https';
import type { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import type { SecureContextOptions } from 'node:tls';

declare class Roster {
    constructor(options?: Roster.RosterOptions);

    /** Register before initialization; accepts `domain:port` and wildcard domains. */
    register(domain: string, site: Roster.SiteFactory | string): this;
    /** Add a synchronous request plugin. */
    use(plugin: Roster.RequestPlugin): this;
    /** Prepare routing and factories without listening. */
    init(): Promise<this>;
    /** Start standalone or local listeners and wait until they are ready. */
    start(): Promise<void>;
    /** Drain and clean up the instance. */
    close(): Promise<void>;
    /** URL for a registered domain, or `null`; local ports are assigned on startup. */
    getUrl(domain: string): string | null;

    /** HTTP dispatcher for a routing port. Requires `init()`. */
    requestHandler(port?: number): RequestListener;
    /** WebSocket upgrade dispatcher for a routing port. Requires `init()`. */
    upgradeHandler(port?: number): (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
    /** Add both dispatchers to a caller-owned server. Requires `init()`. */
    attach(server: HttpServer | HttpsServer, options?: { port?: number }): this;
    /** TLS SNI callback. Requires production-mode `init()`. */
    sniCallback(): NonNullable<HttpsServerOptions['SNICallback']>;

    /** Load existing PEMs or issue missing ones when enabled. Requires production-mode `init()`. */
    ensureCertificate(servername: string): Promise<Roster.Certificate>;
    /** Load PEMs without issuance. Requires production-mode `init()`. */
    loadCertificate(servername: string): Roster.Certificate;
    /** HTTPS server with certificates and dispatchers; does not listen. Requires production-mode `init()`. */
    createManagedHttpsServer(options: Roster.ManagedHttpsServerOptions): Promise<HttpsServer>;
    /** `createManagedHttpsServer()` with `ensureCertificate: false`. */
    createServingHttpsServer(options: Omit<Roster.ManagedHttpsServerOptions, 'ensureCertificate'>): Promise<HttpsServer>;

    /** `https.createServer()` with per-host `SNICallback`, `setSecureContext()` and adopted sockets on Node and Bun. */
    static createHttpsServer(options?: HttpsServerOptions, handler?: RequestListener): HttpsServer;
    /** Hand a raw client socket to a server from `createHttpsServer()` to terminate TLS. */
    static acceptTlsConnection(server: HttpsServer, socket: Socket): void;
    /** Key of a request plugin's descriptor that lets isolated site processes recreate it. */
    static readonly pluginSource: unique symbol;
    static readonly isBunRuntime: boolean;
    static wildcardRoot(pattern: string): string | null;
    static hostMatchesWildcard(host: string, pattern: string): boolean;
    static wildcardSubjectForHost(host: string): string | null;
    static buildCertLookupCandidates(servername: string): string[];
    static certCoversName(certPem: string, name: string): boolean;
}

declare namespace Roster {
    type ServerKeyType = 'RSA-2048' | 'RSA-3072' | 'RSA-4096' | 'EC-P256' | 'EC-P384';

    interface IsolationOptions {
        restartDelayMs?: number;
        backlog?: number;
        helloTimeoutMs?: number;
    }

    interface DnsChallengeOptions {
        module?: string;
        provider?: string;
        propagationDelay?: number;
        dryRunDelay?: number;
        dnsPollIntervalMs?: number;
        dnsPollTimeoutMs?: number;
        autoContinue?: boolean;
        dnsApiFallbackToManual?: boolean;
        /** Provider-specific options passed to the DNS plugin. */
        [option: string]: unknown;
    }

    interface RosterOptions {
        email?: string;
        basePath?: string;
        wwwPath?: string;
        greenlockStorePath?: string;
        /** Script entry basename, without extension. */
        filename?: string;
        local?: boolean;
        port?: number;
        hostname?: string;
        minLocalPort?: number;
        maxLocalPort?: number;
        staging?: boolean;
        autoCertificates?: boolean;
        certificateRenewIntervalMs?: number;
        closeTimeoutMs?: number;
        handleSignals?: boolean;
        isolation?: boolean | IsolationOptions;
        tlsMinVersion?: SecureContextOptions['minVersion'];
        tlsMaxVersion?: SecureContextOptions['maxVersion'];
        keepAliveTimeoutMs?: number;
        serverKeyType?: ServerKeyType;
        skipLocalCheck?: boolean;
        dnsChallenge?: false | DnsChallengeOptions;
        disableWildcard?: boolean;
        combineWildcardCerts?: boolean;
        cluster?: boolean;
    }

    /** PEM strings; `cert` includes the chain. */
    interface Certificate {
        key: string;
        cert: string;
    }

    interface ManagedHttpsServerOptions {
        servername: string;
        port?: number;
        ensureCertificate?: boolean;
        tlsOptions?: HttpsServerOptions;
    }

    /**
     * The server a site factory receives. It stands in for an `http.Server` so libraries such as
     * Socket.IO can attach to it, but it never listens itself.
     */
    interface VirtualServer extends HttpServer {
        readonly domain: string;
        /** Register a cleanup hook that runs once during shutdown, after active requests drain. */
        onClose(hook: () => unknown): this;
    }

    /** A site's request handler, an Express app included. It may be asynchronous. */
    type SiteHandler = (req: IncomingMessage, res: ServerResponse) => unknown;

    /** What a site entry exports: a synchronous factory returning the site's request handler. */
    type SiteFactory = (server: VirtualServer) => SiteHandler;

    interface SocketSiteContext {
        /** Resolves the certificate Roster would serve for that host. Not available in local mode. */
        certificate(servername: string): Promise<Certificate>;
    }

    /** A site entry that serves raw client connections itself. It must run as an isolated site directory. */
    interface SocketSite {
        start?(context: SocketSiteContext): unknown;
        connection(socket: Socket, head: Buffer): void;
        close?(): unknown;
    }

    interface RequestPluginContext {
        host: string;
        domain: string;
    }

    interface PluginSource {
        module: string;
        export: string;
        options?: unknown;
    }

    /** Runs before redirects and site dispatch; return `true` after handling the response. Must be synchronous. */
    interface RequestPlugin {
        (req: IncomingMessage, res: ServerResponse, context: RequestPluginContext): boolean | void;
        [Roster.pluginSource]?: PluginSource;
    }
}

export = Roster;
