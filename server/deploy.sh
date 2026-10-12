#!/bin/sh
# Выкладка сервиса анкет на сервер «Час». Пароль админки живёт только в /etc/vologda-leads/env.
set -eu
HOST="root@45.12.63.159"
KEY="$HOME/.ssh/id_ed25519_chas"
cd "$(dirname "$0")"
rsync -az -e "ssh -i $KEY" server.mjs admin.html "$HOST:/opt/vologda-leads/"
rsync -az -e "ssh -i $KEY" vologda-leads.service "$HOST:/etc/systemd/system/vologda-leads.service"
ssh -i "$KEY" "$HOST" 'systemctl daemon-reload && systemctl restart vologda-leads && sleep 1 && systemctl is-active vologda-leads && curl -s http://127.0.0.1:8797/health'
