'use client';

import { Workspace } from '@/components/Workspace';

/**
 * 首页不做登录拦截：未登录也能进入并浏览，真正需要身份的动作才弹登录框。
 */
export default function PortalHomePage() {
  return <Workspace />;
}
