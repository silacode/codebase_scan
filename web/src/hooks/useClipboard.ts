import { useEffect, useRef, useState } from 'react';

const COPY_SUCCESS_RESET_DELAY_MS = 1_500;

/** Copy text with feedback: 'Copied' clears after a beat; denial suggests manual selection. */
export function useClipboard() {
  const [status, setStatus] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = async (value: string) => {
    clearTimeout(timer.current);
    try {
      await navigator.clipboard.writeText(value);
      setStatus('Copied');
      timer.current = setTimeout(() => setStatus(''), COPY_SUCCESS_RESET_DELAY_MS);
    } catch {
      setStatus('Could not copy. Select the text manually.');
    }
  };
  return { status, copy };
}
