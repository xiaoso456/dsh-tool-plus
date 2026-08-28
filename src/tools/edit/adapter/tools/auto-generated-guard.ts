/**
 * A-3 合并后的纯转发层（second-impl-audit.md A-3）。
 *
 * 唯一实现在 `src/tools/omp/tools/auto-generated-guard.ts`（OMP refs
 * packages/coding-agent/src/tools/auto-generated-guard.ts 的逐字移植，
 * 含 T17-1 Windows basename 修复）。本文件不再持有任何守卫逻辑，仅为
 * 既有 import 路径（omp/edit/hashline/filesystem.ts 等历史引用与单测）
 * 保留转发。
 */
export {
	assertEditableFile,
	assertEditableFileContent,
} from "../../../omp/tools/auto-generated-guard.ts";