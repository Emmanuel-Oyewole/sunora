// Public API of the notifications module. Other modules import only from here.
export { NotificationsModule } from './notifications.module.js';
export {
  NotificationsFacade,
  type EmailRecipient,
  type EmailTemplateKey,
  type EmailTemplateParams,
  type SendEmailRequest,
} from './contracts/notifications.facade.js';
