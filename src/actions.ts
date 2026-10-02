import { createAction } from '@reduxjs/toolkit';

// 跨切片共享动作：货票货位 / 卸货港变化时，压载水切片需要联动使关联水舱配平结论失效
export const moveCargo = createAction<{ id: string; bay: number; row: number; tier: number; fromBay?: number }>('stowage/moveCargo');
export const updateCargoPort = createAction<{ id: string; port: string; bay: number }>('stowage/updateCargoPort');
