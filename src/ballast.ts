import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { moveCargo, updateCargoPort } from './actions';
import { fetchShoreBallast } from './api';

export type TransferSource = 'ship' | 'shore';

export type BallastTransfer = {
  id: string; // 调拨号，幂等键：同一调拨只入账一次
  tankId: string;
  delta: number; // m³，正=打入，负=排出
  position: number; // 关联货位 Bay
  source: TransferSource;
  officer: string;
  recordedAt: string;
  baseVersion: number; // 提交时见到的水舱版本（乐观并发）
  status: 'queued' | 'posted' | 'suspended';
};

export type BallastTank = {
  id: string;
  name: string;
  capacity: number; // m³
  baseVolume: number; // 本航次入账前水量
  linkedBays: number[]; // 关联货位：货票卸货港或货位变化时配平结论失效
  version: number; // 乐观并发版本号
  trim: { status: '有效' | '失效'; text: string };
};

export type ConflictRecord = {
  id: string;
  transferId: string;
  tankId: string;
  field: '水量' | '货位';
  local: BallastTransfer; // 船端记录，挂起期间保留
  remote: BallastTransfer; // 岸端记录，挂起期间保留
  status: '挂起' | '已解决';
  resolution?: 'ship' | 'shore';
};

export type BatchStatus = '本地暂存' | '合并中' | '合并失败' | '待确认' | '已确认';

export type ConcurrencyNotice = {
  officer: string;
  tankId: string;
  tankName: string;
  seenVersion: number;
  currentVersion: number;
  currentVolume: number;
};

export type BallastState = {
  online: boolean;
  tanks: BallastTank[];
  ledger: BallastTransfer[]; // 已入账流水
  queue: BallastTransfer[]; // 本地批次：断网暂存 + 合并失败保留
  conflicts: ConflictRecord[];
  deduped: string[]; // 合并时被去重的调拨号
  batch: { id: string; status: BatchStatus; attempts: number; error: string | null; mergedAt: string | null };
  concurrencyNotice: ConcurrencyNotice | null;
};

// ---------- 派生值：按合并后的入账流水重算 ----------

export function volumeOf(tank: Pick<BallastTank, 'id' | 'baseVolume'>, ledger: BallastTransfer[]) {
  return tank.baseVolume + ledger.filter((item) => item.tankId === tank.id).reduce((sum, item) => sum + item.delta, 0);
}

export function remainingOf(tank: BallastTank, ledger: BallastTransfer[]) {
  return tank.capacity - volumeOf(tank, ledger);
}

function trimText(capacity: number, volume: number) {
  return `装载率 ${Math.round((volume / capacity) * 100)}% · 剩余 ${Math.round(capacity - volume)} m³`;
}

// 稳性裕度：按合并后各舱水量重新计算前后分布
export function ballastMargin(tanks: BallastTank[], ledger: BallastTransfer[]) {
  const fore = tanks.filter((tank) => tank.linkedBays.reduce((a, b) => a + b, 0) / tank.linkedBays.length < 9);
  const foreVolume = fore.reduce((sum, tank) => sum + volumeOf(tank, ledger), 0);
  const aftVolume = tanks.filter((tank) => !fore.includes(tank)).reduce((sum, tank) => sum + volumeOf(tank, ledger), 0);
  const capacity = tanks.reduce((sum, tank) => sum + tank.capacity, 0);
  const imbalance = Math.abs(foreVolume - aftVolume) / Math.max(capacity, 1);
  return Math.max(0, Math.min(100, 96 - imbalance * 160));
}

// 待核：本地批次未合并、合并失败、合并待确认或存在挂起冲突时，锁定与打印标出待核
export function selectPendingVerification(state: BallastState) {
  return (
    state.queue.length > 0 ||
    state.batch.status === '合并失败' ||
    state.batch.status === '待确认' ||
    state.conflicts.some((item) => item.status === '挂起')
  );
}

// ---------- 合并：幂等入账 + 冲突挂起 ----------

function sameTransfer(a: BallastTransfer, b: BallastTransfer) {
  return a.tankId === b.tankId && a.delta === b.delta && a.position === b.position;
}

function makeConflict(transferId: string, local: BallastTransfer, remote: BallastTransfer): ConflictRecord {
  return {
    id: `CF-${transferId}`,
    transferId,
    tankId: local.tankId,
    field: local.delta !== remote.delta ? '水量' : '货位',
    local: { ...local, status: 'suspended' },
    remote: { ...remote, status: 'suspended' },
    status: '挂起'
  };
}

export function mergeBallastRecords(ledger: BallastTransfer[], local: BallastTransfer[], shore: BallastTransfer[]) {
  const posted: BallastTransfer[] = [];
  const conflicts: ConflictRecord[] = [];
  const deduped: string[] = [];
  const known = new Map(ledger.map((item) => [item.id, item]));
  const groups = new Map<string, BallastTransfer[]>();
  [...shore, ...local].forEach((item) => groups.set(item.id, [...(groups.get(item.id) ?? []), item]));
  groups.forEach((list, id) => {
    const first = list[0];
    if (!first) return;
    const existing = known.get(id);
    if (existing) {
      // 已入账的调拨号再次上报：同值去重，异值保留双方并挂起
      if (list.every((item) => sameTransfer(item, existing))) deduped.push(id);
      else conflicts.push(makeConflict(id, existing, list.find((item) => !sameTransfer(item, existing)) ?? first));
      return;
    }
    const ship = list.find((item) => item.source === 'ship');
    const shoreSide = list.find((item) => item.source === 'shore');
    if (ship && shoreSide) {
      if (sameTransfer(ship, shoreSide)) {
        posted.push({ ...ship, status: 'posted' }); // 同一调拨只入账一次
        deduped.push(id);
      } else {
        conflicts.push(makeConflict(id, ship, shoreSide)); // 水量或货位冲突：保留双方并挂起
      }
      return;
    }
    posted.push({ ...first, status: 'posted' });
    if (list.length > 1) deduped.push(id);
  });
  return { posted, conflicts, deduped };
}

// ---------- 初始数据：离港前断网，甲板部已记录 3 笔本地调拨 ----------

const seedTanks: BallastTank[] = [
  { id: 'TK-1', name: 'No.1 艏压载舱', capacity: 420, baseVolume: 260, linkedBays: [2, 4], version: 3, trim: { status: '有效', text: '' } },
  { id: 'TK-2', name: 'No.2 左舷底舱', capacity: 680, baseVolume: 410, linkedBays: [6, 8], version: 5, trim: { status: '有效', text: '' } },
  { id: 'TK-3', name: 'No.3 右舷底舱', capacity: 680, baseVolume: 395, linkedBays: [10, 12], version: 4, trim: { status: '有效', text: '' } },
  { id: 'TK-4', name: 'No.4 艉压载舱', capacity: 540, baseVolume: 300, linkedBays: [14, 15], version: 2, trim: { status: '有效', text: '' } }
];

const seedLedger: BallastTransfer[] = [
  { id: 'BT-2601-04', tankId: 'TK-1', delta: 40, position: 4, source: 'ship', officer: '值班员甲', recordedAt: '08:35', baseVersion: 2, status: 'posted' },
  { id: 'BT-2601-05', tankId: 'TK-2', delta: -60, position: 8, source: 'shore', officer: '岸端调度', recordedAt: '08:50', baseVersion: 4, status: 'posted' }
];

const seedQueue: BallastTransfer[] = [
  { id: 'BT-2602-01', tankId: 'TK-2', delta: -120, position: 8, source: 'ship', officer: '值班员甲', recordedAt: '09:40', baseVersion: 5, status: 'queued' },
  { id: 'BT-2602-02', tankId: 'TK-3', delta: -180, position: 12, source: 'ship', officer: '值班员乙', recordedAt: '09:55', baseVersion: 4, status: 'queued' },
  { id: 'BT-2602-03', tankId: 'TK-4', delta: 80, position: 15, source: 'ship', officer: '值班员甲', recordedAt: '10:05', baseVersion: 2, status: 'queued' }
];

function recalcTrimInPlace(state: BallastState) {
  state.tanks.forEach((tank) => {
    const suspended = state.conflicts.some((item) => item.tankId === tank.id && item.status === '挂起');
    tank.trim = suspended
      ? { status: '失效', text: '存在挂起冲突，待双方核对' }
      : { status: '有效', text: trimText(tank.capacity, volumeOf(tank, state.ledger)) };
  });
}

function invalidateTrim(state: BallastState, bays: (number | undefined)[]) {
  const targets = bays.filter((bay): bay is number => typeof bay === 'number');
  state.tanks.forEach((tank) => {
    if (tank.linkedBays.some((bay) => targets.includes(bay))) {
      tank.trim = { status: '失效', text: '关联货票卸货港或货位已变化' };
    }
  });
}

const defaults: BallastState = {
  online: false, // 离港前断网
  tanks: seedTanks.map((tank) => ({ ...tank, trim: { status: '有效', text: trimText(tank.capacity, volumeOf(tank, seedLedger)) } })),
  ledger: seedLedger,
  queue: seedQueue,
  conflicts: [],
  deduped: [],
  batch: { id: 'BATCH-2602-A', status: '本地暂存', attempts: 0, error: null, mergedAt: null },
  concurrencyNotice: null
};

const persisted = typeof localStorage !== 'undefined' ? localStorage.getItem('yy62-ballast') : null;
const initialState: BallastState = persisted ? { ...defaults, ...JSON.parse(persisted) } : defaults;

// 回网合并：拉取岸端记录与本地批次合并；失败时本地批次保留在 queue 中等待重试
export const mergeLocalBatch = createAsyncThunk<BallastTransfer[], void, { state: { ballast: BallastState }; rejectValue: string }>(
  'ballast/mergeLocalBatch',
  async (_, api) => {
    const attempts = api.getState().ballast.batch.attempts;
    try {
      const shore = await fetchShoreBallast(attempts);
      return shore.map((record) => ({ ...record, source: 'shore' as const, status: 'posted' as const, baseVersion: 0 }));
    } catch {
      return api.rejectWithValue('船岸链路 503 · 合并未完成');
    }
  }
);

const slice = createSlice({
  name: 'ballast',
  initialState,
  reducers: {
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
    },
    // 值班员提交调拨：携带所见版本号，版本不一致时不入账，后到者看到当前版本
    submitAdjustment(state, action: PayloadAction<{ tankId: string; delta: number; position: number; officer: string; baseVersion: number }>) {
      const tank = state.tanks.find((item) => item.id === action.payload.tankId);
      if (!tank) return;
      if (tank.version !== action.payload.baseVersion) {
        state.concurrencyNotice = {
          officer: action.payload.officer,
          tankId: tank.id,
          tankName: tank.name,
          seenVersion: action.payload.baseVersion,
          currentVersion: tank.version,
          currentVolume: volumeOf(tank, state.ledger)
        };
        return;
      }
      const transfer: BallastTransfer = {
        id: `BT-${Date.now().toString(36).toUpperCase()}`,
        tankId: tank.id,
        delta: action.payload.delta,
        position: action.payload.position,
        source: 'ship',
        officer: action.payload.officer,
        recordedAt: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        baseVersion: action.payload.baseVersion,
        status: state.online ? 'posted' : 'queued'
      };
      if (state.online) {
        state.ledger.push(transfer);
        recalcTrimInPlace(state);
      } else {
        state.queue.push(transfer);
        if (state.batch.status === '待确认' || state.batch.status === '已确认') state.batch.status = '本地暂存';
        tank.trim = { status: '失效', text: '本地调拨待合并，结论待重算' };
      }
      tank.version += 1;
    },
    // 冲突裁决：保留双方记录，采用一方入账
    resolveConflict(state, action: PayloadAction<{ id: string; keep: 'ship' | 'shore' }>) {
      const conflict = state.conflicts.find((item) => item.id === action.payload.id);
      if (!conflict || conflict.status !== '挂起') return;
      conflict.status = '已解决';
      conflict.resolution = action.payload.keep;
      const winner = action.payload.keep === 'ship' ? conflict.local : conflict.remote;
      state.ledger.push({ ...winner, status: 'posted' });
      const tank = state.tanks.find((item) => item.id === conflict.tankId);
      if (tank) tank.version += 1;
      recalcTrimInPlace(state);
    },
    // 确认入账：解除锁定与打印的待核标记
    confirmMerge(state) {
      if (state.queue.length === 0 && !state.conflicts.some((item) => item.status === '挂起') && state.batch.status === '待确认') {
        state.batch.status = '已确认';
      }
    },
    recalcTrim(state) {
      recalcTrimInPlace(state);
    },
    dismissConcurrencyNotice(state) {
      state.concurrencyNotice = null;
    }
  },
  extraReducers: (builder) => {
    builder
      // 货票货位或卸货港变化 → 关联水舱配平结论失效
      .addCase(moveCargo, (state, action) => {
        invalidateTrim(state, [action.payload.fromBay, action.payload.bay]);
      })
      .addCase(updateCargoPort, (state, action) => {
        invalidateTrim(state, [action.payload.bay]);
      })
      .addCase(mergeLocalBatch.pending, (state) => {
        state.batch.status = '合并中';
        state.batch.error = null;
      })
      .addCase(mergeLocalBatch.fulfilled, (state, action) => {
        const result = mergeBallastRecords(state.ledger, state.queue, action.payload);
        state.ledger.push(...result.posted);
        state.conflicts.push(...result.conflicts);
        result.deduped.forEach((id) => {
          if (!state.deduped.includes(id)) state.deduped.push(id);
        });
        state.queue = [];
        state.batch.status = '待确认';
        state.batch.mergedAt = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
        state.batch.error = null;
        const touched = new Set(result.posted.map((item) => item.tankId));
        state.tanks.forEach((tank) => {
          if (touched.has(tank.id)) tank.version += 1;
        });
        recalcTrimInPlace(state); // 剩余容量与稳性裕度按合并后的值重算
      })
      .addCase(mergeLocalBatch.rejected, (state, action) => {
        state.batch.status = '合并失败';
        state.batch.attempts += 1;
        state.batch.error = action.payload ?? '船岸链路异常';
        // 本地批次保留在 queue 中，等待重试
      });
  }
});

export const { setOnline, submitAdjustment, resolveConflict, confirmMerge, recalcTrim, dismissConcurrencyNotice } = slice.actions;
export const ballastReducer = slice.reducer;
