/**
 * 最小化的 embedded-postgres 类型声明。
 * 该包是纯 ESM，本项目编译为 CommonJS：运行时用动态 import() 加载，
 * 类型上只需沙箱实际用到的构造/方法。
 */
declare module 'embedded-postgres' {
  export interface EmbeddedPostgresOptions {
    databaseDir: string;
    port: number;
    user: string;
    password: string;
    persistent: boolean;
    authMethod: 'scram-sha-256' | 'password' | 'md5';
    onLog: (message: string) => void;
    onError: (messageOrError: string | Error | unknown) => void;
  }

  export default class EmbeddedPostgres {
    constructor(options?: Partial<EmbeddedPostgresOptions>);
    initialise(): Promise<void>;
    start(): Promise<void>;
    stop(): Promise<void>;
    createDatabase(name: string): Promise<void>;
    dropDatabase(name: string): Promise<void>;
  }
}
