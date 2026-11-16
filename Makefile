SHELL := /bin/bash
COMPOSE_APP := docker compose -f deploy/compose/docker-compose.app.yml

.PHONY: help up-app down-app rebuild backend agent engine worker web test lint

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

up-app: ## 启动本项目应用容器（基础设施复用已有栈）
	$(COMPOSE_APP) up -d --build

down-app: ## 停止本项目应用容器
	$(COMPOSE_APP) down

backend: ## 编译后端
	cd backend && ./mvnw -q -DskipTests package

engine: ## 本地启动 RAG Engine
	cd agent && uv run uvicorn knowledge_hub.api.main:app --reload --port 8100

worker: ## 本地启动索引 Worker
	cd agent && uv run arq knowledge_hub.worker.settings.WorkerSettings

web: ## 本地启动两端
	cd web && pnpm dev

test: ## 全量测试
	cd backend && ./mvnw -q test
	cd agent && uv run pytest -q
	cd web && pnpm -r test