-- ============================================================
-- 班级工作台 - Supabase 建表脚本
-- 在 Supabase 项目 → SQL Editor 中粘贴执行即可
-- ============================================================

-- 0) 【先做】在 Supabase 控制台关闭"邮箱确认"开关（更适合课堂场景）
--    路径：Authentication → Providers → Email → 把 "Confirm email" 设为 OFF
--    这一步在控制台做一次即可，本 SQL 不修改 auth.users（无权限）

-- 1) 业务快照表（每个登录用户一行）
CREATE TABLE IF NOT EXISTS public.snapshots (
    user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    payload    jsonb NOT NULL DEFAULT '{}'::jsonb,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 2) 自动维护 updated_at
CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_snapshots_updated_at ON public.snapshots;
CREATE TRIGGER trg_snapshots_updated_at
    BEFORE UPDATE ON public.snapshots
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 3) RLS：每个登录用户只能读写自己的快照
ALTER TABLE public.snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "snapshots_select_own" ON public.snapshots;
CREATE POLICY "snapshots_select_own"
    ON public.snapshots FOR SELECT
    USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "snapshots_insert_own" ON public.snapshots;
CREATE POLICY "snapshots_insert_own"
    ON public.snapshots FOR INSERT
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "snapshots_update_own" ON public.snapshots;
CREATE POLICY "snapshots_update_own"
    ON public.snapshots FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "snapshots_delete_own" ON public.snapshots;
CREATE POLICY "snapshots_delete_own"
    ON public.snapshots FOR DELETE
    USING (auth.uid() = user_id);

-- 4) 给已登录用户自动创建快照行（INSERT ... ON CONFLICT DO NOTHING 风格）
--    也可以在客户端 upsert；这里建一个辅助函数方便日后扩展
CREATE OR REPLACE FUNCTION public.ensure_snapshot_row() RETURNS void AS $$
BEGIN
    INSERT INTO public.snapshots (user_id, payload)
    VALUES (auth.uid(), '{}'::jsonb)
    ON CONFLICT (user_id) DO NOTHING;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
