import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './i18n';
import './styles.css';

function setupRendererLogging(): void {
  const timestamp = () => new Date().toISOString();

  const patchConsoleMethod = (method: 'log' | 'info' | 'warn' | 'error' | 'debug'): void => {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      original(`[${timestamp()}]`, ...args);
    };
  };

  patchConsoleMethod('log');
  patchConsoleMethod('info');
  patchConsoleMethod('warn');
  patchConsoleMethod('error');
  patchConsoleMethod('debug');
}

setupRendererLogging();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
