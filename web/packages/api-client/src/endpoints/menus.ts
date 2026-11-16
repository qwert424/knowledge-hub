import type { ApiClient } from '../http';

export interface MenuItemView {
  id: string;
  section: string;
  key: string;
  label: string;
  path: string;
  permission?: string | null;
  sortOrder: number;
  /** 不进侧栏，但直接访问路由仍然可用 */
  hidden: boolean;
  /** 停用：既不进侧栏，路由也挡住 */
  enabled: boolean;
}

export interface CreateMenuItemRequest {
  label: string;
  path: string;
  section?: string;
  permission?: string;
  sortOrder?: number;
  hidden?: boolean;
  enabled?: boolean;
}

export interface UpdateMenuItemRequest {
  section?: string;
  label?: string;
  path?: string;
  permission?: string;
  sortOrder?: number;
  hidden?: boolean;
  enabled?: boolean;
}

/** 菜单配置：导航不再写死在前端，租户可增删/排序/绑定权限码 */
export function createMenuApi(client: ApiClient) {
  return {
    list: () => client.request<MenuItemView[]>('/api/v1/admin/menus'),
    create: (body: CreateMenuItemRequest) =>
      client.request<MenuItemView>('/api/v1/admin/menus', { method: 'POST', body }),
    update: (id: string, body: UpdateMenuItemRequest) =>
      client.request<MenuItemView>(`/api/v1/admin/menus/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body,
      }),
    remove: (id: string) =>
      client.request<void>(`/api/v1/admin/menus/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    reorder: (ids: string[]) =>
      client.request<MenuItemView[]>('/api/v1/admin/menus/order', { method: 'PATCH', body: { ids } }),
    reset: () => client.request<MenuItemView[]>('/api/v1/admin/menus/reset', { method: 'POST' }),
  };
}

export type MenuApi = ReturnType<typeof createMenuApi>;
