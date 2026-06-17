SHELL := /bin/bash

# Ports (keep in sync with vite.config.ts / server PORT)
CLIENT_PORT := 12345
SERVER_PORT := 23456
LOG := dev.log

.PHONY: run-bg kill logs run

## Start both servers in the background; logs -> dev.log
run-bg:
	@nohup npm run dev > $(LOG) 2>&1 & disown; \
	echo "noter started in background -> client :$(CLIENT_PORT), server :$(SERVER_PORT)"; \
	echo "logs: tail -f $(LOG)  |  stop: make kill"

## Stop whatever is running on the client/server ports
kill:
	@pids=$$(lsof -ti :$(CLIENT_PORT) -ti :$(SERVER_PORT) 2>/dev/null); \
	if [ -n "$$pids" ]; then kill $$pids && echo "stopped: $$pids"; \
	else echo "nothing running on :$(CLIENT_PORT)/:$(SERVER_PORT)"; fi

## Tail the background logs
logs:
	@tail -f $(LOG)

## Run in the foreground (Ctrl-C to stop)
run:
	@npm run dev
