import {Container, ObjectFactory} from 'typescript-ioc';

export abstract class Logger {
  readonly info: string;
  text: string;
  abstract log(message: string, context?: any): void;
  abstract logn(message: string, context?: any): void;
  abstract debug(message: string, context?: any): void;
  abstract error(message: string, context?: any): void;
  abstract stop(): void;
  abstract child(context: string): Logger;
}

export const logFactory: (config: {verbose?: boolean, spinner?: boolean}) => ObjectFactory = ({verbose = process.env.VERBOSE_LOGGING === 'true', spinner = process.env.LOGGING_SPINNER === 'false'}: {verbose?: boolean, spinner?: boolean}): ObjectFactory => {
  return () => {
    return new VerboseLogger();
  }
}

export const verboseLoggerFactory: (verbose?: boolean) => ObjectFactory = (verbose: boolean = process.env.VERBOSE_LOGGING === 'true') => {
  return () => {
    return new VerboseLogger(verbose);
  }
}

class VerboseLogger implements Logger {
  constructor(private verbose?: boolean, private readonly context: string = '') {}

  set text(text) {
    this.log(text);
  }

  get info() {
    return 'verbose logger';
  }

  log(message: string, context?: any): void {
    if (context) {
      console.log(this.msg(message), context);
    } else {
      console.log(this.msg(message));
    }
  }


  logn(message: string, context?: any): void {
    process.stdout.write(this.msg(message));
  }

  debug(message: string, context?: any): void {
    if (!this.verbose) return;

    if (context) {
      console.log(this.msg(message), context);
    } else {
      console.log(this.msg(message));
    }
  }

  error(message: string, context?: any): void {
    if (!this.verbose) return;

    if (context) {
      console.error(this.msg(message), context);
    } else {
      console.error(this.msg(message));
    }
  }

  stop() {}

  private msg(message: string): string {
    if (this.context) {
      return `${this.context}: ${message}`;
    }

    return message;
  }

  child(context: string): Logger {
    return new VerboseLogger(this.verbose, context);
  }
}

Container.bind(Logger).factory(verboseLoggerFactory());
