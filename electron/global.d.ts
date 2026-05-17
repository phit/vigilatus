export {};

declare global {
  interface Window {
    tapoStudio: {
      getPlatform(): Promise<NodeJS.Platform>;
    };
  }
}