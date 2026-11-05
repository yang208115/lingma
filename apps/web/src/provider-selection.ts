import { useEffect, useState } from 'react';

/** Keep model choices scoped to the work, across its setting and writing pages. */
export function useProjectProvider(projectId: string) {
  const key = `lingma:provider:${projectId}`;
  const [providerId, setProviderId] = useState(() => {
    try {
      return sessionStorage.getItem(key) ?? '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    if (!providerId) return;
    try {
      sessionStorage.setItem(key, providerId);
    } catch {
      /* Model selection remains usable without browser storage. */
    }
  }, [key, providerId]);
  return [providerId, setProviderId] as const;
}
