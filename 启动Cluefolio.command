#!/bin/zsh
set -euo pipefail

project_dir="${0:A:h}"
port="${PORT:-4317}"
url="http://127.0.0.1:$port/"
cd "$project_dir"

log_dir="${XHS_DATA_DIR:-$project_dir/data}"
pid_file="$log_dir/workbench-$port.pid"
if [[ "${1:-}" == "--stop" ]]; then
  [[ -s "$pid_file" ]] || { print "找不到此工作台的进程记录。"; exit 1; }
  pid="$(<"$pid_file")"
  [[ "$pid" == <-> ]] &&
    /usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/grep -Fxq "n$project_dir" &&
    /bin/ps -p "$pid" -o command= | /usr/bin/grep -Fq ' --import tsx apps/server/index.ts' ||
    { print -u2 "进程记录已失效。"; exit 1; }
  kill -TERM "$pid"
  print "已停止本地工作台。"
  exit 0
fi

open_workbench() {
  if [[ "${SHIZHI_NO_OPEN:-}" != 1 ]]; then /usr/bin/open "$url"; fi
}
if /usr/bin/curl -fsS --max-time 1 "${url}api/projects" >/dev/null 2>&1; then
  open_workbench
  exit 0
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
node_bin="$(command -v node)" || { print -u2 "请先安装 Node.js 24。"; exit 1; }
[[ -f dist/web/index.html && -d node_modules ]] || {
  print -u2 "请在仓库目录运行 npm ci 和 npm run build。"
  exit 1
}
mkdir -p "$log_dir"
/usr/bin/screen -dmS "xhs-skill-distiller-$port" /bin/zsh -c \
  'cd "$1" && print -r -- "$$" > "$4" && exec "$2" --import tsx apps/server/index.ts >>"$3" 2>&1' \
  shizhi "$project_dir" "$node_bin" "$log_dir/screen-server.log" "$pid_file"

for _ in {1..20}; do
  if /usr/bin/curl -fsS --max-time 1 "${url}api/projects" >/dev/null 2>&1; then
    open_workbench
    exit 0
  fi
  /bin/sleep 0.5
done

print -u2 "服务未能启动。日志位于 $log_dir/screen-server.log"
exit 1
