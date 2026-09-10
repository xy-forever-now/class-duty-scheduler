# 云端存储：Supabase 接入指南

本应用把业务数据（学生 / 值班表 / 座位表 / 考勤 / 积分）持久化到 Supabase 云端 PostgreSQL，
按登录用户隔离，每个老师只能看到自己的数据。

## 一次性配置（约 5 分钟）

### 第 1 步：创建 Supabase 项目

1. 打开 <https://supabase.com> 并登录
2. 点击 "New Project"，填一个名字（如 `class-workbench`），设置一个数据库密码
3. 等待约 1 分钟项目创建完成

### 第 2 步：执行建表脚本

1. 在项目左侧菜单点击 "SQL Editor"
2. 新建一个 Query，把 [supabase-setup.sql](./supabase-setup.sql) 文件内容**完整粘贴**进去
3. 点击 "Run"，看到 "Success" 即成功

### 第 3 步：拿到 URL 和 anon key

1. 项目左侧菜单 → "Project Settings" → "API"
2. 复制：
   - **Project URL**（形如 `https://xxxxx.supabase.co`）
   - **anon public key**（一长串 `eyJ...` 开头）

### 第 4 步：填入应用

首次打开应用时，应用顶部会弹出"云端配置"对话框，把上面两个值粘贴进去即可。
配置只存在浏览器 localStorage，不上传到任何第三方。

> 提示：如果想换账号 / 换项目，点击顶部 `☁️ 云端` → `重新配置` 可重新填写。

## 安全说明

- **anon key** 设计上就是公开的（前端可见），所以数据库通过 RLS 强制"只能读写自己的行"
- 没有邮箱确认：老师注册完即可登录（课堂场景体验优先）。如需恢复邮箱确认，
  把 `supabase-setup.sql` 里第一段 `ALTER TABLE auth.users ...` 那行注释掉即可
- 数据形状：一个 JSONB 字段（`payload`），存整个应用快照，`updated_at` 自动维护
