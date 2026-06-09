declare module 'epub' {
  import { EventEmitter } from 'events';

  interface SpineItem {
    id: string;
    href: string;
    title?: string;
    mediaType?: string;
    order?: number;
  }

  interface EpubMetadata {
    title?: string;
    creator?: string;
    subject?: string;
    description?: string;
    publisher?: string;
    contributor?: string;
    date?: string;
    type?: string;
    format?: string;
    source?: string;
    language?: string;
    relation?: string;
    coverage?: string;
    rights?: string;
    ISBN?: string;
    UUID?: string;
  }

  class EPub extends EventEmitter {
    metadata: EpubMetadata;
    flow: SpineItem[];
    manifest: Record<string, SpineItem>;

    constructor(filename: string, imagewebroot?: string, chapterwebroot?: string);

    parse(): void;

    getChapter(
      id: string,
      callback: (error: Error | null, text: string) => void,
    ): void;

    getImage(
      id: string,
      callback: (error: Error | null, data: Buffer, mimeType: string) => void,
    ): void;
  }

  export = EPub;
}
