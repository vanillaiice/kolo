import type { ComponentType } from "react";
import type { RouteName } from "../../app/navigation.tsx";
import { CartScreen, PaymentScreen, SellScreen } from "../sell/sell.tsx";
import { CategoriesScreen, CategoryFormScreen, ProductFormScreen, ProductScreen, ProductsScreen, StockHistoryScreen, StockMoveScreen } from "../products/products.tsx";
import { ActivityScreen, ExpenseNewScreen, ExpenseScreen, PurchaseNewScreen, PurchaseScreen, ReceiptScreen, ReturnFormScreen } from "../activity/activity.tsx";
import { CustomersScreen, PersonFormScreen, PersonScreen, SettleScreen, StatementScreen, SuppliersScreen } from "../people/people.tsx";
import { AccountFormScreen, AccountScreen, AccountsScreen, CashCountScreen, MoneyScreen } from "../finance/finance.tsx";
import { AnalyticsScreen, ReportScreen, ReportsScreen } from "../reports/reports.tsx";
import { StaffMemberScreen, StaffNewScreen, StaffRolesScreen, StaffScreen } from "../staff/staff.tsx";
import { AddTillScreen, BackupCreateScreen, BackupRestoreScreen, DevicesScreen, ExchangeConfirmScreen, ExchangeReceiveScreen, ExchangeSendScreen, ExchangeStatusScreen, RecoveryKeyScreen, BackupKeyScreen } from "../devices/devices.tsx";
import { ServerSyncScreen } from "../devices/server-sync.tsx";
import { AboutScreen, MoreScreen, ResetScreen, SettingsScreen } from "../more/more.tsx";
import { AlertsScreen } from "../more/alerts.tsx";
import { JournalScreen } from "../more/journal.tsx";
import { PartyTermsScreen, ProductTaxScreen, ShopTaxScreen, ShopTermsScreen } from "../more/shop-settings.tsx";

/** Every route's screen. Screens read their parameters with `useParams`. */
export const SCREENS: Record<RouteName, ComponentType> = {
  sell: SellScreen, cart: CartScreen, payment: PaymentScreen, receipt: ReceiptScreen,
  products: ProductsScreen, product: ProductScreen, productForm: ProductFormScreen, stockMove: StockMoveScreen, stockHistory: StockHistoryScreen,
  categories: CategoriesScreen, categoryForm: CategoryFormScreen,
  activity: ActivityScreen, purchase: PurchaseScreen, purchaseNew: PurchaseNewScreen, expense: ExpenseScreen, expenseNew: ExpenseNewScreen, returnForm: ReturnFormScreen,
  more: MoreScreen, customers: CustomersScreen, suppliers: SuppliersScreen, person: PersonScreen, personForm: PersonFormScreen, settle: SettleScreen, statement: StatementScreen,
  accounts: AccountsScreen, account: AccountScreen, accountForm: AccountFormScreen, money: MoneyScreen, cashCount: CashCountScreen,
  reports: ReportsScreen, report: ReportScreen, analytics: AnalyticsScreen,
  staff: StaffScreen, staffMember: StaffMemberScreen, staffNew: StaffNewScreen, staffRoles: StaffRolesScreen,
  devices: DevicesScreen, backupCreate: BackupCreateScreen, backupRestore: BackupRestoreScreen, addTill: AddTillScreen, exchangeSend: ExchangeSendScreen,
  exchangeReceive: ExchangeReceiveScreen, exchangeConfirm: ExchangeConfirmScreen, exchangeStatus: ExchangeStatusScreen, recoveryKey: RecoveryKeyScreen, backupKey: BackupKeyScreen, serverSync: ServerSyncScreen,
  settings: SettingsScreen, about: AboutScreen, reset: ResetScreen,
  alerts: AlertsScreen, journal: JournalScreen, shopTax: ShopTaxScreen, shopTerms: ShopTermsScreen, partyTerms: PartyTermsScreen, productTax: ProductTaxScreen,
};

/** Routes shown beside their list on wide screens (list/detail, catalogue/cart). */
export const DETAIL_ROUTES: ReadonlySet<RouteName> = new Set<RouteName>(["product", "person", "account", "receipt", "purchase", "expense", "report", "staffMember", "cart", "statement", "stockHistory"]);
