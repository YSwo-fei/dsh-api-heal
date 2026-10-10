<#
.SYNOPSIS
  安装 / 卸载 dsh-api-heal 插件。

.DESCRIPTION
  DSH 的 workspace-write 沙箱不允许写 E:\dsh-data\.dsh（$DSH_HOME），
  所以插件源码先落在工作区，由本脚本复制进插件目录并挂到 profile 上。

  做四件事：
    1. 备份 profile 的 package.json
    2. 复制插件到 $DshHome\plugins\dsh-api-heal
    3. 把 dsh-api-heal 加进 profile 的 dependencies 与 dsh.profile.bundles
    4. 在 profile 目录跑 pnpm install

  文本编辑一律用「定位 + 字符串切片」，不用正则回调，也不重排原文件排版。

.PARAMETER DshHome
  DSH 的 home 目录，默认 E:\dsh-data\.dsh

.PARAMETER Profile
  profile 名，默认 desktop

.PARAMETER SkipInstall
  只改文件，不跑 pnpm install

.PARAMETER Uninstall
  反向操作：从 profile 摘掉依赖与 bundle，并删除已安装的插件目录。

.EXAMPLE
  install.cmd
  install.cmd -Uninstall
#>
[CmdletBinding()]
param(
  [string]$DshHome = "E:\dsh-data\.dsh",
  [string]$Profile = "desktop",
  [switch]$SkipInstall,
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$SourceDir   = $PSScriptRoot
$PluginName  = "dsh-api-heal"
$PluginDir   = Join-Path $DshHome "plugins\$PluginName"
$ProfileDir  = Join-Path $DshHome "profiles\$Profile"
$PkgPath     = Join-Path $ProfileDir "package.json"

$RuntimeRoot = "D:\DSH\resources\runtime"
$NodeExe     = Join-Path $RuntimeRoot "primary-runtime\dependencies\node\bin\node.exe"
$PnpmCjs     = Join-Path $RuntimeRoot "pnpm\bin\pnpm.cjs"

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "    OK  $Text" -ForegroundColor Green }
function Write-Note([string]$Text) { Write-Host "    !!  $Text" -ForegroundColor Yellow }

function Save-Text([string]$Path, [string]$Text) {
  [System.IO.File]::WriteAllText($Path, $Text, $Utf8NoBom)
}

# 在 JSON 文本里，把 $Insert 插到第一个匹配 $Pattern 的位置之后（保持其余排版不动）
function Insert-After([string]$Text, [string]$Pattern, [string]$Insert) {
  $m = [regex]::Match($Text, $Pattern)
  if (-not $m.Success) { throw "定位不到：$Pattern" }
  $at = $m.Index + $m.Length
  return $Text.Substring(0, $at) + $Insert + $Text.Substring($at)
}

# 替换第一个匹配 $Pattern 的捕获组 1（保持组 0 的前后缀不动）
function Replace-Group1([string]$Text, [string]$Pattern, [string]$NewValue) {
  $m = [regex]::Match($Text, $Pattern)
  if (-not $m.Success) { throw "定位不到：$Pattern" }
  $g = $m.Groups[1]
  return $Text.Substring(0, $g.Index) + $NewValue + $Text.Substring($g.Index + $g.Length)
}

# ---------------------------------------------------------------- 前置检查
Write-Step "检查环境"
if (-not (Test-Path -LiteralPath $ProfileDir)) { throw "找不到 profile 目录：$ProfileDir" }
if (-not (Test-Path -LiteralPath $PkgPath))    { throw "找不到 profile 的 package.json：$PkgPath" }
Write-Ok "profile = $ProfileDir"

if (-not $SkipInstall) {
  if (-not (Test-Path -LiteralPath $NodeExe)) { throw "找不到 node：$NodeExe" }
  if (-not (Test-Path -LiteralPath $PnpmCjs)) { throw "找不到 pnpm：$PnpmCjs" }
}

$running = @(Get-Process -Name "DeepSeek Harness" -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  Write-Note "DSH 正在运行（PID $($running.Id -join ', ')）。装完必须重启 DSH 才会生效。"
}

$raw = Get-Content -LiteralPath $PkgPath -Raw -Encoding UTF8
$null = $raw | ConvertFrom-Json          # 先确认原始文件是合法 JSON
Write-Ok "package.json 解析正常"

$stamp  = Get-Date -Format "yyyyMMdd-HHmmss"
$backup = "$PkgPath.bak-$stamp"

# ================================================================= 卸载分支
if ($Uninstall) {
  Write-Step "卸载"

  Copy-Item -LiteralPath $PkgPath -Destination $backup -Force
  Write-Ok "已备份 -> $backup"

  $doc = $raw | ConvertFrom-Json

  if (@($doc.dependencies.PSObject.Properties.Name) -contains $PluginName) {
    # 删掉整行 `"dsh-api-heal": "...",`（含行尾换行）
    $linePattern = '(?m)^[ \t]*"' + [regex]::Escape($PluginName) + '"[ \t]*:[ \t]*"[^"]*"[ \t]*,?[ \t]*\r?\n'
    if ($raw -match $linePattern) {
      $raw = [regex]::Replace($raw, $linePattern, '', 1)
      Write-Ok "已从 dependencies 摘除"
    } else {
      Write-Note "dependencies 里有它，但没匹配到整行，请手工检查"
    }
  }

  if (@($doc.dsh.profile.bundles) -contains $PluginName) {
    $bundlePattern = ',\s*"' + [regex]::Escape($PluginName) + '"|"' + [regex]::Escape($PluginName) + '"\s*,'
    if ($raw -match $bundlePattern) {
      $raw = [regex]::Replace($raw, $bundlePattern, '', 1)
      Write-Ok "已从 dsh.profile.bundles 摘除"
    } else {
      Write-Note "bundles 里有它，但没匹配到，请手工检查"
    }
  }

  $null = $raw | ConvertFrom-Json
  Save-Text $PkgPath $raw
  Write-Ok "package.json 已写回（JSON 校验通过）"

  if (Test-Path -LiteralPath $PluginDir) {
    Remove-Item -LiteralPath $PluginDir -Recurse -Force
    Write-Ok "已删除 $PluginDir"
  }

  if (-not $SkipInstall) {
    Write-Step "pnpm install"
    & $NodeExe $PnpmCjs install --no-frozen-lockfile --dir $ProfileDir
    if ($LASTEXITCODE -ne 0) { Write-Note "pnpm install 退出码 $LASTEXITCODE（可能需要手动处理）" }
  }

  Write-Host ""
  Write-Host "卸载完成。重启 DSH 生效。" -ForegroundColor Green
  return
}

# ================================================================= 安装分支
Write-Step "复制插件到 $PluginDir"
New-Item -ItemType Directory -Path (Split-Path -Parent $PluginDir) -Force | Out-Null
if (Test-Path -LiteralPath $PluginDir) {
  $oldBackup = "$PluginDir.bak-$stamp"
  Move-Item -LiteralPath $PluginDir -Destination $oldBackup -Force
  Write-Ok "旧版本已挪到 $oldBackup"
}
New-Item -ItemType Directory -Path $PluginDir -Force | Out-Null

foreach ($item in @("lib", "package.json", "cordis.patch.yml", "README.md", "selftest.mjs", "smoke.mjs")) {
  $from = Join-Path $SourceDir $item
  if (Test-Path -LiteralPath $from) {
    Copy-Item -LiteralPath $from -Destination $PluginDir -Recurse -Force
  } else {
    Write-Note "源里没有 $item，跳过"
  }
}
Write-Ok "已复制 $((Get-ChildItem -LiteralPath $PluginDir -Recurse -File).Count) 个文件"

# ------------------------------------------------- 改 profile 的 package.json
Write-Step "更新 profile 的 package.json"
Copy-Item -LiteralPath $PkgPath -Destination $backup -Force
Write-Ok "已备份 -> $backup"

$doc       = $raw | ConvertFrom-Json
$hasDep    = @($doc.dependencies.PSObject.Properties.Name) -contains $PluginName
$hasBundle = @($doc.dsh.profile.bundles) -contains $PluginName

if (-not $hasDep) {
  $depLine = "`r`n    `"$PluginName`": `"file:$($PluginDir -replace '\\','/')`","
  $raw = Insert-After $raw '"dependencies"[ \t]*:[ \t]*\{' $depLine
  Write-Ok "已加入 dependencies"
} else {
  Write-Ok "dependencies 里已有 $PluginName，跳过"
}

if (-not $hasBundle) {
  $newInner = Replace-Group1 $raw '"bundles"[ \t]*:[ \t]*\[([^\]]*)\]' $null
  # Replace-Group1 需要一个值，这里手工算一遍更直观
  $m = [regex]::Match($raw, '"bundles"[ \t]*:[ \t]*\[([^\]]*)\]')
  if (-not $m.Success) { throw "在 package.json 里定位不到 dsh.profile.bundles 数组" }
  $g     = $m.Groups[1]
  $core  = $g.Value.Trim()
  if ($core.Length -eq 0) {
    $inner = "`r`n      `"$PluginName`"`r`n    "
  } else {
    $core  = $core.TrimEnd(',')
    $items = @($core -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 })
    $inner = "`r`n      " + (($items + "`"$PluginName`"") -join ",`r`n      ") + "`r`n    "
  }
  $raw = $raw.Substring(0, $g.Index) + $inner + $raw.Substring($g.Index + $g.Length)
  Write-Ok "已加入 dsh.profile.bundles（$($items.Count + 1) 项）"
} else {
  Write-Ok "bundles 里已有 $PluginName，跳过"
}

$null = $raw | ConvertFrom-Json      # 写回前再校验一次
Save-Text $PkgPath $raw
Write-Ok "package.json 已写回（UTF-8 无 BOM，JSON 校验通过）"

# ------------------------------------------------------------------ pnpm
if (-not $SkipInstall) {
  Write-Step "pnpm install（在 $ProfileDir）"
  & $NodeExe $PnpmCjs install --no-frozen-lockfile --dir $ProfileDir
  if ($LASTEXITCODE -ne 0) {
    Write-Note "pnpm install 退出码 $LASTEXITCODE"
    Write-Note "回滚：Copy-Item `"$backup`" `"$PkgPath`" -Force"
  } else {
    Write-Ok "依赖安装完成"
  }
}

# ------------------------------------------------------------ 装后自检
Write-Step "装后自检（真实打通三家上游）"
$env:DSH_HOME = $DshHome
Push-Location $PluginDir
try {
  & $NodeExe "selftest.mjs"
  if ($LASTEXITCODE -eq 0) { Write-Ok "自检通过" } else { Write-Note "自检退出码 $LASTEXITCODE" }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "安装完成。" -ForegroundColor Green
Write-Host ""
Write-Host "接下来：" -ForegroundColor Cyan
Write-Host "  1. 完全退出并重启 DSH（托盘也要退干净）"
Write-Host "  2. 验证：GET http://127.0.0.1:19387/plugins/dsh-api-heal/status"
Write-Host "  3. 或者直接让 AI 调一次 heal_api 工具"
Write-Host ""
Write-Host "回滚：" -ForegroundColor Cyan
Write-Host "  install.cmd -Uninstall"
Write-Host "  （本次备份：$backup）"
