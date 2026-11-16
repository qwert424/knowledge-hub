import type { ApiClient } from '../http';
import type {
  CreateGroupRequest,
  CreateRoleRequest,
  CreateUserRequest,
  GroupView,
  PageResult,
  PermissionDef,
  RoleView,
  UpdateUserRequest,
  UserView,
} from '../types';

export function createIamApi(client: ApiClient) {
  return {
    listUsers: (query: { keyword?: string; page?: number; pageSize?: number } = {}) =>
      client.request<PageResult<UserView>>('/api/v1/users', {
        query: { keyword: query.keyword, page: query.page ?? 1, pageSize: query.pageSize ?? 20 },
      }),
    createUser: (body: CreateUserRequest) => client.request<UserView>('/api/v1/users', { method: 'POST', body }),
    updateUser: (id: string, body: UpdateUserRequest) =>
      client.request<UserView>(`/api/v1/users/${encodeURIComponent(id)}`, { method: 'PUT', body }),
    assignRoles: (id: string, roles: string[]) =>
      client.request<void>(`/api/v1/users/${encodeURIComponent(id)}/roles`, {
        method: 'POST',
        body: { roles },
      }),

    listRoles: () => client.request<RoleView[]>('/api/v1/roles'),
    createRole: (body: CreateRoleRequest) =>
      client.request<RoleView>('/api/v1/roles', { method: 'POST', body }),
    setRolePermissions: (id: string, permissions: string[]) =>
      client.request<void>(`/api/v1/roles/${encodeURIComponent(id)}/permissions`, {
        method: 'PUT',
        body: { permissions },
      }),
    listPermissions: () => client.request<PermissionDef[]>('/api/v1/permissions'),

    listGroups: () => client.request<GroupView[]>('/api/v1/groups'),
    createGroup: (body: CreateGroupRequest) =>
      client.request<GroupView>('/api/v1/groups', { method: 'POST', body }),
    addGroupMember: (id: string, userId: string) =>
      client.request<void>(`/api/v1/groups/${encodeURIComponent(id)}/members`, {
        method: 'POST',
        body: { userId },
      }),

    /** 资源 ACL 覆盖（知识库/文档/数据源/Agent） */
    setResourceAcl: (type: string, id: string, body: unknown) =>
      client.request<void>(`/api/v1/resources/${encodeURIComponent(type)}/${encodeURIComponent(id)}/acl`, {
        method: 'PUT',
        body,
      }),
    /** 权限预览：给定用户 + 文档，返回最终可读性与命中主体 */
    previewAcl: (body: { userId: string; documentId: string }) =>
      client.request<Record<string, unknown>>('/api/v1/acl/preview', { method: 'POST', body }),
  };
}

export type IamApi = ReturnType<typeof createIamApi>;
