// 压载水调拨：断网记录、船岸合并、冲突挂起与重算逻辑

export type TankSide = '左舷' | '右舷' | '中';
export type TrimConclusion = '配平' | '偏艏' | '偏艉' | '失效';

export type BallastTank = {
  id: string;
  name: string;
  side: TankSide;
  capacity: number;      // 舱容 m³
  current: number;       // 当前水量 m³
  linkedCargoId?: string; // 关联货票
  trimConclusion: TrimConclusion;
  version: number;       // 并发版本号
};

export type TransferStatus = '正常' | '挂起';
export type TransferSource = '船端' | '岸端';

export type BallastTransfer = {
  id: string;
  tankId: string;
  volume: number;        // 正为注入, 负为排出
  time: string;
  operator: string;
  source: TransferSource;
  status: TransferStatus;
  conflictWith?: string;
  batchId: string;
  cargoBay?: number;     // 记录时关联货位快照
};

export type BatchStatus = '待合并' | '合并失败' | '已合并';

export type LocalBatch = {
  id: string;
  createdAt: string;
  transfers: BallastTransfer[];
  status: BatchStatus;
  retries: number;
};

export type MergeResult = {
  merged: BallastTransfer[];
  suspended: BallastTransfer[];
  duplicates: string[];
  appliedVolume: number;
};

export const initialTanks: BallastTank[] = [
  { id: 'T-P1', name: '左压载舱 No.1', side: '左舷', capacity: 86, current: 42, linkedCargoId: 'BL-88214', trimConclusion: '配平', version: 1 },
  { id: 'T-S1', name: '右压载舱 No.1', side: '右舷', capacity: 86, current: 38, linkedCargoId: 'BL-88214', trimConclusion: '配平', version: 1 },
  { id: 'T-P2', name: '左压载舱 No.2', side: '左舷', capacity: 120, current: 65, trimConclusion: '配平', version: 1 },
  { id: 'T-S2', name: '右压载舱 No.2', side: '右舷', capacity: 120, current: 60, trimConclusion: '配平', version: 1 },
  { id: 'T-C', name: '中压载舱', side: '中', capacity: 150, current: 70, trimConclusion: '偏艉', version: 1 }
];

// 岸端记录（回网后获取）
export const shoreTransfers: BallastTransfer[] = [
  { id: 'BT-2609-001', tankId: 'T-P1', volume: 12, time: '2026-10-02 08:10', operator: '岸端调度', source: '岸端', status: '正常', batchId: 'shore', cargoBay: 12 },
  { id: 'BT-2609-002', tankId: 'T-S1', volume: -8, time: '2026-10-02 08:25', operator: '岸端调度', source: '岸端', status: '正常', batchId: 'shore', cargoBay: 12 },
  { id: 'BT-2609-003', tankId: 'T-P2', volume: 15, time: '2026-10-02 09:00', operator: '岸端调度', source: '岸端', status: '正常', batchId: 'shore' }
];

// 船端断网批次（离港前甲板部本地记录）
export const initialBatches: LocalBatch[] = [
  {
    id: 'BATCH-LOCAL-001',
    createdAt: '2026-10-02 09:30',
    status: '待合并',
    retries: 0,
    transfers: [
      // 与岸端 BT-2609-001 同舱同时刻但水量不一致 → 水量冲突
      { id: 'BT-LOCAL-001', tankId: 'T-P1', volume: 14, time: '2026-10-02 08:10', operator: '张值班', source: '船端', status: '正常', batchId: 'BATCH-LOCAL-001', cargoBay: 12 },
      // 与岸端 BT-2609-002 同舱同时刻同水量, 但货位快照不一致 → 货位冲突
      { id: 'BT-LOCAL-002', tankId: 'T-S1', volume: -8, time: '2026-10-02 08:25', operator: '张值班', source: '船端', status: '正常', batchId: 'BATCH-LOCAL-001', cargoBay: 10 }
    ]
  }
];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));

// 合并船岸记录：同一调拨只入账一次；水量或货位冲突时保留双方并挂起
export function mergeTransfers(
  local: BallastTransfer[],
  shore: BallastTransfer[],
  cargoBayMap: Record<string, number>,
  tankCargoMap: Record<string, string | undefined>
): MergeResult {
  const merged: BallastTransfer[] = [];
  const seenIds = new Set<string>();
  const suspended: BallastTransfer[] = [];
  const duplicates: string[] = [];

  const add = (t: BallastTransfer) => {
    if (seenIds.has(t.id)) {
      duplicates.push(t.id); // 同一调拨只入账一次
      return;
    }
    seenIds.add(t.id);
    merged.push({ ...t });
  };

  for (const t of shore) add(t);

  for (const localTransfer of local) {
    if (seenIds.has(localTransfer.id)) {
      duplicates.push(localTransfer.id);
      continue;
    }
    // 水量冲突：同舱 + 同一时刻 + 水量不一致
    const waterRival = merged.find(
      (m) => m.tankId === localTransfer.tankId && m.time === localTransfer.time && m.volume !== localTransfer.volume
    );
    // 货位冲突：调拨货位快照与关联货票当前货位不一致
    const linkedCargoId = tankCargoMap[localTransfer.tankId];
    const cargoMoved =
      localTransfer.cargoBay != null && linkedCargoId != null && cargoBayMap[linkedCargoId] != null &&
      cargoBayMap[linkedCargoId] !== localTransfer.cargoBay;

    if (waterRival || cargoMoved) {
      // 保留双方并挂起
      const localCopy: BallastTransfer = {
        ...localTransfer,
        status: '挂起',
        conflictWith: waterRival?.id
      };
      merged.push(localCopy);
      suspended.push(localCopy);
      if (waterRival) {
        waterRival.status = '挂起';
        waterRival.conflictWith = localTransfer.id;
        suspended.push(waterRival);
      }
      seenIds.add(localTransfer.id);
    } else {
      add(localTransfer);
    }
  }

  const appliedVolume = merged
    .filter((t) => t.status === '正常')
    .reduce((sum, t) => sum + t.volume, 0);

  return { merged, suspended, duplicates, appliedVolume };
}

// 按合并后的值重算各舱水量与剩余容量
export function recalcTanks(tanks: BallastTank[], transfers: BallastTransfer[]): BallastTank[] {
  return tanks.map((tank) => {
    const delta = transfers
      .filter((t) => t.tankId === tank.id && t.status === '正常')
      .reduce((sum, t) => sum + t.volume, 0);
    const current = clamp(tank.current + delta, 0, tank.capacity);
    return { ...tank, current };
  });
}

export function remainingCapacity(tank: BallastTank): number {
  return Math.max(0, tank.capacity - tank.current);
}

// 按合并后的值重算稳性裕度
export function ballastStabilityMargin(tanks: BallastTank[]): number {
  const port = tanks.filter((t) => t.side === '左舷').reduce((s, t) => s + t.current, 0);
  const starboard = tanks.filter((t) => t.side === '右舷').reduce((s, t) => s + t.current, 0);
  const center = tanks.filter((t) => t.side === '中').reduce((s, t) => s + t.current, 0);
  const total = port + starboard + center;
  const list = Math.abs(port - starboard);
  const balance = total > 0 ? 1 - list / total : 1;
  const margin = clamp(42 + balance * 42 - center * 0.04, 0, 100);
  return margin;
}
