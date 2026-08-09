import type { Provider } from '@nestjs/common';
import {
  ACCOUNT_CAPITAL_REPOSITORY,
  ACCOUNT_LABEL_REPOSITORY,
  ACCOUNT_PROFILE_REPOSITORY,
  ACCOUNT_REPOSITORY,
  ACCOUNT_USER_MOVE_HISTORY_REPOSITORY,
  ACCOUNT_USER_REPOSITORY,
  ACCOUNTING_PERIOD_REPOSITORY,
  ARTICLE_REPOSITORY,
  ATTENDANCE_REPOSITORY,
  ATTENDANCE_SETTING_REPOSITORY,
  COA_REPOSITORY,
  DASHBOARD_USER_REPOSITORY,
  DEVICE_SESSION_REPOSITORY,
  EMAIL_MESSAGE_REPOSITORY,
  EMAIL_REPOSITORY,
  EMAIL_SUBJECT_REPOSITORY,
  JOURNAL_ENTRY_REPOSITORY,
  JOURNAL_LINE_REPOSITORY,
  JOURNAL_TEMPLATE_REPOSITORY,
  JOURNAL_TEMPLATE_ITEM_REPOSITORY,
  LABEL_REPOSITORY,
  MANUAL_BOOK_CATEGORY_REPOSITORY,
  MANUAL_BOOK_REPOSITORY,
  PEAK_HOUR_STATISTICS_REPOSITORY,
  PERMISSION_REPOSITORY,
  PLATFORM_PRODUCT_REPOSITORY,
  PLATFORM_STATISTICS_REPOSITORY,
  PRODUCT_REPOSITORY,
  PRODUCT_SALES_STATISTICS_REPOSITORY,
  PRODUCT_VARIANT_REPOSITORY,
  PROMO_CODE_REPOSITORY,
  REVENUE_STATISTICS_REPOSITORY,
  ROLE_PERMISSION_REPOSITORY,
  ROLE_REPOSITORY,
  SHIFT_REPOSITORY,
  SHOP_REPOSITORY,
  SYSLOG_REPOSITORY,
  SHORT_URL_REPOSITORY,

  TASK_QUEUE_REPOSITORY,
  TENANT_BANK_ACCOUNT_REPOSITORY,
  TENANT_OWNER_REPOSITORY,
  TENANT_REPOSITORY,
  TENANT_SETTING_REPOSITORY,
  TRANSACTION_ITEM_REPOSITORY,
  TRANSACTION_REPOSITORY,
  TUTORIAL_REPOSITORY,
  USER_SHIFT_REPOSITORY,
  VOUCHER_REPOSITORY,
  WEEKLY_OFF_REQUEST_REPOSITORY,
  WEEKLY_OFF_SCHEDULE_REPOSITORY,
  WITHDRAWAL_REQUEST_REPOSITORY,
  PLATFORM_ACCOUNTING_SETTING_REPOSITORY,
  ACCOUNT_SESSION_REPOSITORY,
} from 'src/constants/database.const';
import { AccountSession } from './models/account-session.model';
import { AccountCapital } from './models/account-capital.model';
import { AccountLabel } from './models/account-label.model';
import { AccountProfile } from './models/account-profile.model';
import { AccountUserMoveHistory } from './models/account-user-move-history.model';
import { AccountUser } from './models/account-user.model';
import { Account } from './models/account.model';
import { Article } from './models/article.model';
import { AttendanceSetting } from './models/attendance-setting.model';
import { Attendance } from './models/attendance.model';
import { DashboardUser } from './models/dashboard-user.model';
import { DeviceSession } from './models/device-session.model';
import { EmailMessage } from './models/email-message.model';
import { EmailSubject } from './models/email-subject.model';
import { Email } from './models/email.model';
import { Label } from './models/label.model';
import { ManualBookCategory } from './models/manual-book-category.model';
import { ManualBook } from './models/manual-book.model';
import { PeakHourStatistics } from './models/peak-hour-statistics.model';
import { Permission } from './models/permission.model';
import { PlatformProduct } from './models/platform-product.model';
import { PlatformStatistics } from './models/platform-statistics.model';
import { ProductSalesStatistics } from './models/product-sales-statistics.model';
import { ProductVariant } from './models/product-variant.model';
import { Product } from './models/product.model';
import { PromoCode } from './models/promo-code.model';
import { RevenueStatistics } from './models/revenue-statistics.model';
import { RolePermission } from './models/role-permission.model';
import { Role } from './models/role.model';
import { Shift } from './models/shift.model';
import { Shop } from './models/shop.model';
import { Syslog } from './models/syslog.model';
import { TaskQueue } from './models/task-queue.model';
import { TenantBankAccount } from './models/tenant-bank-account.model';
import { TenantOwner } from './models/tenant-owner.model';
import { TenantSetting } from './models/tenant-setting.model';
import { Tenant } from './models/tenant.model';
import { TransactionItem } from './models/transaction-item.model';
import { Transaction } from './models/transaction.model';
import { Tutorial } from './models/tutorial.model';
import { UserShift } from './models/user-shift.model';
import { Voucher } from './models/voucher.model';
import { WeeklyOffRequest } from './models/weekly-off-request.model';
import { WeeklyOffSchedule } from './models/weekly-off-schedule.model';
import { WithdrawalRequest } from './models/withdrawal-request.model';
import { ShortUrl } from './models/short-url.model';

export const RepositoryProvider: Provider[] = [
  { provide: TENANT_REPOSITORY, useValue: Tenant },
  { provide: TASK_QUEUE_REPOSITORY, useValue: TaskQueue },
  { provide: EMAIL_REPOSITORY, useValue: Email },
  { provide: PRODUCT_REPOSITORY, useValue: Product },
  { provide: PRODUCT_VARIANT_REPOSITORY, useValue: ProductVariant },
  { provide: PLATFORM_PRODUCT_REPOSITORY, useValue: PlatformProduct },
  { provide: ACCOUNT_REPOSITORY, useValue: Account },
  { provide: ACCOUNT_PROFILE_REPOSITORY, useValue: AccountProfile },
  { provide: ACCOUNT_USER_REPOSITORY, useValue: AccountUser },
  { provide: TRANSACTION_REPOSITORY, useValue: Transaction },
  { provide: TRANSACTION_ITEM_REPOSITORY, useValue: TransactionItem },
  { provide: REVENUE_STATISTICS_REPOSITORY, useValue: RevenueStatistics },
  {
    provide: PRODUCT_SALES_STATISTICS_REPOSITORY,
    useValue: ProductSalesStatistics,
  },
  { provide: PEAK_HOUR_STATISTICS_REPOSITORY, useValue: PeakHourStatistics },
  { provide: PLATFORM_STATISTICS_REPOSITORY, useValue: PlatformStatistics },
  { provide: EMAIL_SUBJECT_REPOSITORY, useValue: EmailSubject },
  { provide: EMAIL_MESSAGE_REPOSITORY, useValue: EmailMessage },
  { provide: VOUCHER_REPOSITORY, useValue: Voucher },
  { provide: SYSLOG_REPOSITORY, useValue: Syslog },
  { provide: TENANT_SETTING_REPOSITORY, useValue: TenantSetting },
  { provide: TUTORIAL_REPOSITORY, useValue: Tutorial },
  { provide: ARTICLE_REPOSITORY, useValue: Article },
  { provide: ACCOUNT_CAPITAL_REPOSITORY, useValue: AccountCapital },
  { provide: TENANT_OWNER_REPOSITORY, useValue: TenantOwner },
  { provide: PROMO_CODE_REPOSITORY, useValue: PromoCode },
  { provide: WITHDRAWAL_REQUEST_REPOSITORY, useValue: WithdrawalRequest },
  { provide: TENANT_BANK_ACCOUNT_REPOSITORY, useValue: TenantBankAccount },
  { provide: ROLE_REPOSITORY, useValue: Role },
  { provide: PERMISSION_REPOSITORY, useValue: Permission },
  { provide: ROLE_PERMISSION_REPOSITORY, useValue: RolePermission },
  { provide: DASHBOARD_USER_REPOSITORY, useValue: DashboardUser },
  { provide: DEVICE_SESSION_REPOSITORY, useValue: DeviceSession },
  { provide: LABEL_REPOSITORY, useValue: Label },
  { provide: ACCOUNT_LABEL_REPOSITORY, useValue: AccountLabel },
  { provide: ACCOUNT_USER_MOVE_HISTORY_REPOSITORY, useValue: AccountUserMoveHistory },
  { provide: SHIFT_REPOSITORY, useValue: Shift },
  { provide: USER_SHIFT_REPOSITORY, useValue: UserShift },
  { provide: ATTENDANCE_REPOSITORY, useValue: Attendance },
  { provide: WEEKLY_OFF_SCHEDULE_REPOSITORY, useValue: WeeklyOffSchedule },
  { provide: WEEKLY_OFF_REQUEST_REPOSITORY, useValue: WeeklyOffRequest },
  { provide: ATTENDANCE_SETTING_REPOSITORY, useValue: AttendanceSetting },
  { provide: MANUAL_BOOK_CATEGORY_REPOSITORY, useValue: ManualBookCategory },
  { provide: MANUAL_BOOK_REPOSITORY, useValue: ManualBook },
  { provide: SHORT_URL_REPOSITORY, useValue: ShortUrl },
  { provide: SHOP_REPOSITORY, useValue: Shop },
  { provide: ACCOUNT_SESSION_REPOSITORY, useValue: AccountSession },
];
