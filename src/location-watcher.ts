export interface LocationWatcher {
  check(): void;
  stop(): void;
}

export function watchLocationChanges(
  onChange: () => void,
  intervalMs = 250
): LocationWatcher {
  let href = location.href;
  const check = () => {
    const nextHref = location.href;
    if (nextHref === href) return;
    href = nextHref;
    onChange();
  };
  const timer = window.setInterval(check, intervalMs);
  return {
    check,
    stop: () => window.clearInterval(timer)
  };
}
