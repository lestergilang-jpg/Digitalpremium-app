export type TaskQueueContext = 'SUBS_END_NOTIFY' | 'NETFLIX_RESET_PASSWORD' | 'NETFLIX_AUTO_RELOAD' | 'NETFLIX_AUTO_UPGRADE' | 'NETFLIX_LOGIN_TV' | 'NETFLIX_GET_TOKEN' | 'UNFREEZE_ACCOUNT';

export interface TaskQueueData {
  id: string;
  tenant_id: string;
  context: TaskQueueContext;
  payload: any;
}
