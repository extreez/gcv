# Ставит мета-скилл gcv вместе с шаблоном и проверялкой контракта.
#   .\install.ps1            -> ~\.claude\skills\gcv  (глобально)
#   .\install.ps1 -Project   -> .claude\skills\gcv    (в текущий проект)
#   .\install.ps1 -Dir PATH  -> произвольная папка
param(
  [switch]$Project,
  [string]$Dir
)

$ErrorActionPreference = 'Stop'
$skill = 'gcv'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

$dest = if ($Dir)         { Join-Path $Dir $skill }
        elseif ($Project) { Join-Path '.claude\skills' $skill }
        else              { Join-Path $HOME ".claude\skills\$skill" }

# Шаблон и проверялка обязаны лежать рядом со скиллом: SKILL.md зовёт их
# относительными путями (templates\scaffold.mjs, templates\verify-contract.mjs).
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item (Join-Path $here 'SKILL.md') (Join-Path $dest 'SKILL.md') -Force
foreach ($d in 'templates','reference') {
  $target = Join-Path $dest $d
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Copy-Item -Recurse (Join-Path $here $d) $target
}
Write-Host "OK  скилл установлен: $dest"

$node = Get-Command node -ErrorAction SilentlyContinue
if ($node) {
  $major = [int](& node -p 'process.versions.node.split(".")[0]')
  if ($major -ge 20) { Write-Host "OK  Node $(& node -v)" }
  else { Write-Host "!   Node $(& node -v) — нужен 20 или новее, иначе scaffold и verify-contract не запустятся" }
} else {
  Write-Host '!   Node не найден. Нужен 20+: https://nodejs.org'
}

Write-Host ''
Write-Host 'Проверка, что каркас рабочий (ничего не публикует, ничего не тратит):'
Write-Host "    node $dest\templates\scaffold.mjs --service demo --name Demo --out $env:TEMP\gcv-demo"
Write-Host "    node $dest\templates\verify-contract.mjs $env:TEMP\gcv-demo"
Write-Host ''
Write-Host 'Дальше в чате:  /gcv add <ссылка на документацию сервиса>'
