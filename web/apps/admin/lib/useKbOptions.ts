'use client';

import { useApi } from './providers';
import { useQuery } from '@tanstack/react-query';
import type { KbView } from '@kh/api-client';
import { useMemo } from 'react';

/** 知识库下拉数据源（两端共用同一份缓存 key） */
export function useKbOptions(pageSize = 200) {
  const api = useApi();
  const query = useQuery({
    queryKey: ['kbs', 'options', pageSize],
    queryFn: () => api.kbs.list({ page: 1, pageSize }),
  });

  const kbs: KbView[] = query.data?.items ?? [];
  const options = useMemo(
    () => kbs.map((kb) => ({ label: `${kb.name}（${kb.code}）`, value: kb.id })),
    [kbs],
  );
  /** 只能选上架中的库（文档写入/转移都要求目标库可用） */
  const activeOptions = useMemo(
    () =>
      kbs
        .filter((kb) => !kb.status || kb.status === 'active')
        .map((kb) => ({ label: `${kb.name}（${kb.code}）`, value: kb.id })),
    [kbs],
  );
  const nameById = useMemo(() => {
    const map = new Map<string, string>();
    kbs.forEach((kb) => map.set(kb.id, kb.name));
    return map;
  }, [kbs]);

  return { ...query, kbs, options, activeOptions, nameById };
}
