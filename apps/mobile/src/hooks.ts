import { useIsFocused } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

export function useAppActive(): boolean {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setActive(s === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

export function useScreenActive(): boolean {
  const focused = useIsFocused();
  const appActive = useAppActive();
  return focused && appActive;
}

/** The time, refreshed every `intervalMs` while `active`: only the component that shows it re-renders. */
export function useNow(active = true, intervalMs = 1000): number {
  const [now, setNow] = useState<number>(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
