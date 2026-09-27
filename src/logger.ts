export type LogFields = Record<string, string | number | boolean | undefined>;

export type Logger = { info(event: string, fields?: LogFields): void; error(event: string, fields?: LogFields): void };

const write = (level: string, event: string, fields: LogFields = {}): void => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
};

export const logger: Logger = {
  info: (event, fields) => write("info", event, fields),
  error: (event, fields) => write("error", event, fields),
};

export const silentLogger: Logger = { info: () => {}, error: () => {} };
