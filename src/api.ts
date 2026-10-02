import { createApi } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn } from '@reduxjs/toolkit/query';

export type CargoType = '集装箱' | '散货' | '重大件';
export type Cargo = {
  id: string;
  bill: string;
  type: CargoType;
  bay: number;
  row: number;
  tier: number;
  deck: '主甲板' | '货舱';
  weight: number;
  dimension: string;
  port: string;
  hazmat: string;
  lashing: '已绑扎' | '待绑扎' | '需复核';
  color: string;
};

const voyageData = {
  id: 'V-2609-17',
  vessel: '海岳轮',
  imo: 'IMO 9782214',
  route: '上海 → 釜山 → 温哥华',
  departure: '2026-10-02 14:00',
  revision: 5,
  cargo: [
    { id: 'BL-88214', bill: 'SEA-88214', type: '集装箱', bay: 12, row: 4, tier: 2, deck: '主甲板', weight: 24.6, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '已绑扎', color: '#2b7c75' },
    { id: 'BL-88219', bill: 'SEA-88219', type: '集装箱', bay: 13, row: 4, tier: 2, deck: '主甲板', weight: 28.1, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: 'UN 1263', lashing: '需复核', color: '#c77835' },
    { id: 'BL-88231', bill: 'SEA-88231', type: '集装箱', bay: 10, row: 6, tier: 1, deck: '主甲板', weight: 18.2, dimension: '20 × 8 × 8.6 ft', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#366d94' },
    { id: 'BL-88240', bill: 'SEA-88240', type: '集装箱', bay: 8, row: 2, tier: 2, deck: '货舱', weight: 31.4, dimension: '40 × 8 × 8.6 ft', port: '温哥华', hazmat: '无', lashing: '待绑扎', color: '#6d528d' },
    { id: 'BL-88247', bill: 'SEA-88247', type: '重大件', bay: 15, row: 0, tier: 1, deck: '主甲板', weight: 112.5, dimension: '18.4 × 4.2 × 4.8 m', port: '温哥华', hazmat: '无', lashing: '需复核', color: '#b64f49' },
    { id: 'BL-88254', bill: 'SEA-88254', type: '散货', bay: 5, row: 0, tier: 0, deck: '货舱', weight: 286.0, dimension: '散装 / 420 m³', port: '釜山', hazmat: '无', lashing: '已绑扎', color: '#9a7836' }
  ] as Cargo[]
};

export type ShoreBallastRecord = {
  id: string;
  tankId: string;
  delta: number;
  position: number;
  officer: string;
  recordedAt: string;
};

// 岸端（船公司调度系统）已入账的压载水调拨记录
// BT-2602-01 与船端本地批次同号同值 → 合并时去重，只入账一次
// BT-2602-02 与船端同号但水量不同 → 水量冲突，保留双方并挂起
// BT-2602-03 与船端同号但货位不同 → 货位冲突，保留双方并挂起
// BT-2602-11 岸端独有 → 合并时直接入账
const shoreBallast: ShoreBallastRecord[] = [
  { id: 'BT-2602-01', tankId: 'TK-2', delta: -120, position: 8, officer: '岸端调度', recordedAt: '10:02' },
  { id: 'BT-2602-02', tankId: 'TK-3', delta: -150, position: 12, officer: '岸端调度', recordedAt: '10:04' },
  { id: 'BT-2602-03', tankId: 'TK-4', delta: 80, position: 14, officer: '岸端调度', recordedAt: '10:06' },
  { id: 'BT-2602-11', tankId: 'TK-1', delta: 60, position: 4, officer: '岸端调度', recordedAt: '10:08' }
];

// 模拟船岸链路：首次合并（attempt 0）网关 503，用于演示“合并失败后保留本地批次并重试”
export async function fetchShoreBallast(attempt: number): Promise<ShoreBallastRecord[]> {
  await new Promise((resolve) => setTimeout(resolve, 420));
  if (attempt === 0) throw new Error('shore-gateway 503');
  return shoreBallast.map((record) => ({ ...record }));
}

const mockBaseQuery: BaseQueryFn = async (arg) => {
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (arg === 'voyage' || (typeof arg === 'object' && arg && 'url' in arg && (arg as { url: string }).url === 'voyage')) return { data: voyageData };
  return { error: { status: 404, data: 'Not found' } };
};

export const stowageApi = createApi({
  reducerPath: 'stowageApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Voyage'],
  endpoints: (builder) => ({
    getVoyage: builder.query<typeof voyageData, void>({ query: () => 'voyage', providesTags: ['Voyage'] })
  })
});

export const { useGetVoyageQuery } = stowageApi;
