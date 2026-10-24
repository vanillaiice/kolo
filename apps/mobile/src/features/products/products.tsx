import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { categories, category as categoryRead, products, productStock, stockHistory, stockLevels } from "@kolo/core/application/queries";
import { productPhotoDigests } from "@kolo/core/application/photos";
import { product as productRead, productCategories } from "@kolo/core/application/records";
import { adjustStock, countStock, saveCategory, saveProduct, setProductCategories } from "@kolo/core/application/operations";
import type { Product } from "@kolo/core/data/products/products";
import type { Category } from "@kolo/core/data/products/categories";
import type { Row } from "@kolo/core/data/database/driver";
import { moneyEntry, quantityEntry, quantityInput } from "@kolo/core/domain/entry";
import { formatMoney, formatQuantity, formatQuantityWithUnit } from "@kolo/core/domain/money";
import { newIdOnDevice } from "../../data/auth/local-credentials-on-device.ts";
import { useText, type TextKey } from "../../app/i18n.tsx";
import { useLeaveGuard, useNav, useParams } from "../../app/navigation.tsx";
import { usePermissions, useRevision, useSession } from "../../app/session.tsx";
import { FormProblem, StaleRecord, useAction } from "../../components/command.tsx";
import { spacing } from "../../components/theme.ts";
import { Button, Confirm, EmptyState, Facts, Field, ListRow, Notice, PagedList, Picker, RowGroup, Screen, Section, Toggle, useStyles } from "../../components/ui.tsx";
import { formatDate, nextVersion, requireVersion, useRecord, useRequestId } from "../shared.tsx";
import { PhotoSection, Thumbnail } from "./photos.tsx";

const MOVEMENT_KEYS: Record<string, TextKey> = { PURCHASE: "movement.PURCHASE", SALE: "movement.SALE", SALE_RETURN: "movement.SALE_RETURN", PURCHASE_RETURN: "movement.PURCHASE_RETURN",
  DAMAGE: "damage", ADJUSTMENT: "adjust", STOCK_COUNT: "countStock", TRANSFER_OUT: "movement.TRANSFER_OUT", TRANSFER_IN: "movement.TRANSFER_IN", OPENING_BALANCE: "opening" };

/** Searchable catalogue; creation sits on the list, record actions on the detail. */
export function ProductsScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { context } = useSession(), permissions = usePermissions(), revision = useRevision(["products", "inventory"]);
  const [archived, setArchived] = useState(false), showStock = permissions.includes("inventory.view");
  return <Screen title={t("tab.products")} scroll={false} actions={permissions.includes("products.create") ? <Button label={t("new")} variant="ghost" onPress={() => nav.push("productForm", {})} /> : undefined}>
    <PagedList<Product & { stock?: number; photo?: string }> revision={revision} identify={item => item.id} deps={[archived]} searchLabel={t("searchProducts")}
      load={page => {
        const result = products(context, { ...page, includeInactive: archived }), ids = result.items.map(item => item.id);
        const stock = showStock ? stockLevels(context, ids) : undefined, photos = productPhotoDigests(context, ids);
        return { ...result, items: result.items.map(item => ({ ...item, ...(stock?.has(item.id) ? { stock: stock.get(item.id)! } : {}), ...(photos.has(item.id) ? { photo: photos.get(item.id)! } : {}) })) };
      }}
      header={<><Toggle label={t("showArchived")} value={archived} onChange={setArchived} hint={t("hint.showArchived")} />
        <Button label={t("categories")} variant="secondary" onPress={() => nav.push("categories")} /></>}
      empty={{ title: t("noProducts"), text: t("noProductsHelp") }}
      render={item => <ListRow title={item.name} tag={item.active ? undefined : t("archived")} leading={<Thumbnail productId={item.id} name={item.name} digest={item.photo ?? null} />}
        subtitle={item.stock === undefined ? item.barcode : `${t("stock")} ${formatQuantityWithUnit(item.stock, item.unit, language)}${item.stock < 0 ? ` · ${t("negativeStock")}` : ""}`}
        trailing={formatMoney(item.sellingPriceMinor)} trailingTone={item.stock !== undefined && item.stock < 0 ? "danger" : "normal"} onPress={() => nav.push("product", { productId: item.id })} />} />
  </Screen>;
}

/** Product facts, stock and the actions this actor may take on it. */
export function ProductScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { productId } = useParams("product"), { context } = useSession(), permissions = usePermissions();
  const revision = useRevision(["products", "inventory"]), action = useAction(), [archiving, setArchiving] = useState(false);
  const { value: item, failed } = useRecord(() => productRead(context, productId), [context, productId, revision]);
  const stock = useRecord(() => permissions.includes("inventory.view") ? productStock(context, productId) : undefined, [context, productId, revision, permissions]).value;
  const group = useRecord(() => item?.categoryId === undefined ? undefined : categoryRead(context, item.categoryId), [context, item?.categoryId, revision]).value;
  const others = useRecord(() => productCategories(context, productId).categories, [context, productId, revision]).value ?? [];
  if (item === undefined) return <Screen title={t("product")} onBack={nav.back}>{failed ? <Notice tone="error" text={t("loadFailed")} /> : <EmptyState title={t("notFound")} />}</Screen>;
  const can = (p: Parameters<typeof permissions.includes>[0]): boolean => permissions.includes(p);
  const toggleActive = (): void => action.run(() => {
    const stored = productRead(context, productId); requireVersion(stored, item.updatedAt);
    if (!saveProduct(context, { ...stored!, active: !stored!.active, updatedAt: nextVersion(stored!.updatedAt) })) throw new FormProblem("newerEdit");
  }, undefined, item.active ? "productArchived" : "productRestored");
  return <Screen title={item.name} eyebrow={t("product")} onBack={nav.back}>
    {!item.active && <Notice tone="warning" text={t("productArchivedHelp")} />}
    <Section>
      <Facts items={[[t("price"), formatMoney(item.sellingPriceMinor), "strong"], [t("cost"), item.purchasePriceMinor === undefined ? t("unknown") : formatMoney(item.purchasePriceMinor)],
        [t("stock"), stock === undefined ? undefined : formatQuantityWithUnit(stock.onHandThousandths, item.unit, language), stock !== undefined && stock.onHandThousandths < 0 ? "danger" : undefined],
        [t("minimum"), formatQuantity(item.minimumStock)], [t("barcode"), item.barcode], [t("unit"), item.unit], [t("mainCategory"), group?.name], [t("otherCategories"), others.map(other => other.name).join(", ")],
        [t("divisible"), item.divisible ? t("yes") : t("no")], [t("updated"), formatDate(item.updatedAt, language)]]} />
      {stock !== undefined && stock.onHandThousandths < 0 && <Notice tone="warning" text={t("negativeStock")} />}
    </Section>
    {item.active && (can("inventory.adjust") || can("inventory.count")) && <Section title={t("stockActions")}>
      {can("inventory.adjust") && <Button label={t("adjust")} variant="secondary" onPress={() => nav.push("stockMove", { productId, kind: "ADJUSTMENT" })} />}
      {can("inventory.adjust") && <Button label={t("damage")} variant="secondary" onPress={() => nav.push("stockMove", { productId, kind: "DAMAGE" })} />}
      {can("inventory.adjust") && stock?.movements === 0 && <Button label={t("opening")} variant="secondary" onPress={() => nav.push("stockMove", { productId, kind: "OPENING_BALANCE" })} />}
      {can("inventory.count") && <Button label={t("countStock")} variant="secondary" onPress={() => nav.push("stockMove", { productId, kind: "COUNT" })} />}
    </Section>}
    {can("inventory.view") && <RowGroup><ListRow title={t("history")} onPress={() => nav.push("stockHistory", { productId })} /></RowGroup>}
    <RowGroup><ListRow title={t("productTax")} onPress={() => nav.push("productTax", { productId })} /></RowGroup>
    <PhotoSection productId={productId} name={item.name} />
    {action.notice}
    {item.active && can("products.edit") && <Button label={t("edit")} onPress={() => nav.push("productForm", { productId })} />}
    {can("products.archive") && can("products.edit") && <Button label={t(item.active ? "archive" : "restore")} variant={item.active ? "danger" : "secondary"} onPress={() => item.active ? setArchiving(true) : toggleActive()} />}
    <Confirm visible={archiving} destructive title={t("archiveProductTitle", { name: item.name })} text={t("archiveProductText")} confirmLabel={t("archive")}
      onCancel={() => setArchiving(false)} onConfirm={() => { setArchiving(false); toggleActive(); }} />
  </Screen>;
}

/** Product creation (with optional opening stock) or editing from the displayed version. */
export function ProductFormScreen(): React.JSX.Element {
  const { t } = useText(), s = useStyles(), nav = useNav(), { productId } = useParams("productForm"), { context, branchId } = useSession(), permissions = usePermissions();
  const revision = useRevision(["products"]), action = useAction(), request = useRequestId(), openingRequest = useRequestId(), openingSaved = useRef(false);
  const loaded = useMemo(() => { try { return productId === undefined ? undefined : productRead(context, productId); } catch { return undefined; } }, [context, productId]);
  const [name, setName] = useState(loaded?.name ?? ""), [unit, setUnit] = useState(loaded?.unit ?? t("defaultUnit")), [barcode, setBarcode] = useState(loaded?.barcode ?? "");
  const [price, setPrice] = useState(loaded === undefined ? "" : String(loaded.sellingPriceMinor)), [cost, setCost] = useState(loaded?.purchasePriceMinor === undefined ? "" : String(loaded.purchasePriceMinor));
  const [minimum, setMinimum] = useState(loaded === undefined ? "" : quantityInput(loaded.minimumStock)), [divisible, setDivisible] = useState(loaded?.divisible ?? false);
  const [group, setGroup] = useState<Category | undefined>(() => { try { return loaded?.categoryId === undefined ? undefined : categoryRead(context, loaded.categoryId); } catch { return undefined; } });
  const [opening, setOpening] = useState("");
  const loadedSet = useMemo(() => { try { return loaded === undefined ? { categories: [] } : productCategories(context, loaded.id); } catch { return { categories: [] }; } }, [context, loaded]);
  const [extras, setExtras] = useState<readonly { readonly id: string; readonly name: string }[]>(() => loadedSet.categories.map(({ id, name }) => ({ id, name })));
  const dirty = loaded === undefined ? name !== "" || price !== "" || barcode !== "" : name !== loaded.name || price !== String(loaded.sellingPriceMinor) || barcode !== (loaded.barcode ?? "") || unit !== loaded.unit;
  useLeaveGuard(dirty);
  const canPrice = loaded === undefined || permissions.includes("products.price");
  const categoryAction = useAction();
  /** Records a new category from the picker so the product form keeps its draft. */
  const newCategory = permissions.includes("products.create") ? { label: t("newCategory"), hint: t("hint.newCategory"), notice: categoryAction.notice, add: (title: string, select: (item: Category) => void): void => categoryAction.run(() => {
    if (title.trim() === "") throw new FormProblem("nameRequired");
    const now = new Date().toISOString(), id = newIdOnDevice();
    saveCategory(context, { id, name: title.trim(), active: true, createdAt: now, updatedAt: now });
    return categoryRead(context, id)!;
  }, select) } : undefined;
  /** Writes the additional categories only when they changed; the main category is never among them. */
  const saveExtras = (id: string): void => {
    const set = productCategories(context, id), wanted = extras.map(item => item.id).filter(item => item !== group?.id).sort();
    if (wanted.join() === set.categories.map(item => item.id).sort().join()) return;
    if (!setProductCategories(context, { productId: id, categoryIds: wanted, updatedAt: set.updatedAt === undefined ? new Date().toISOString() : nextVersion(set.updatedAt) })) throw new FormProblem("newerEdit");
  };
  const save = (): void => action.run(() => {
    if (name.trim() === "" || unit.trim() === "") throw new FormProblem("nameAndUnitRequired");
    const now = new Date().toISOString(), selling = moneyEntry(price), purchase = cost.trim() === "" ? undefined : moneyEntry(cost);
    const base = { name: name.trim(), unit: unit.trim(), barcode: barcode.trim() || undefined, sellingPriceMinor: selling, purchasePriceMinor: purchase,
      minimumStock: minimum.trim() === "" ? 0 : quantityEntry(minimum, divisible), categoryId: group?.id };
    if (loaded === undefined) {
      const id = request.current, openingUnits = opening.trim() === "" ? 0 : quantityEntry(opening, divisible);
      if (productRead(context, id) === undefined) saveProduct(context, { id, ...base, divisible, currency: "XAF", taxRateBasisPoints: 0, active: true, createdAt: now, updatedAt: now });
      // Product and opening stock are separate commits; a retry after a failed opening reuses both IDs.
      if (openingUnits > 0 && !openingSaved.current) {
        adjustStock(context, { id: openingRequest.current, productId: id, branchId, type: "OPENING_BALANCE", quantity: openingUnits, reason: t("opening"), occurredAt: now }, newIdOnDevice());
        openingSaved.current = true;
      }
      saveExtras(id);
      return id;
    }
    const stored = productRead(context, loaded.id); requireVersion(stored, loaded.updatedAt);
    const set = productCategories(context, loaded.id);
    if (set.updatedAt !== loadedSet.updatedAt) throw new StaleRecord();
    if (!saveProduct(context, { ...stored!, ...base, divisible: stored!.divisible, updatedAt: nextVersion(stored!.updatedAt) })) throw new FormProblem("newerEdit");
    saveExtras(loaded.id);
    return loaded.id;
  }, id => { request.renew(); openingRequest.renew(); openingSaved.current = false; if (loaded === undefined) nav.replace("product", { productId: id }); else nav.leave(); });
  return <Screen title={loaded === undefined ? t("newProduct") : t("editProduct")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    {/* What the product is and where it is found come first; price, then stock settings, follow. */}
    <Section title={t("section.product")}>
      <Field label={t("name")} value={name} onChange={setName} autoFocus={loaded === undefined} hint={t("hint.productName")} />
      <Picker<Category> label={t("mainCategory")} value={group} onChange={value => { setGroup(value); if (value !== undefined) setExtras(current => current.filter(item => item.id !== value.id)); }} optional
        load={page => categories(context, page)} revision={revision} create={newCategory} hint={t("hint.mainCategory")} />
      {extras.length > 0 && <View style={{ gap: spacing.xs }}><Text style={[s.muted, { fontWeight: "600" }]}>{t("otherCategories")}</Text>
        <RowGroup>{extras.map(item => <ListRow key={item.id} title={item.name} trailing={t("remove")} trailingTone="muted" accessibilityLabel={t("removeLineLabel", { name: item.name })}
          onPress={() => setExtras(current => current.filter(other => other.id !== item.id))} />)}</RowGroup></View>}
      {extras.length < 20 && <Picker<Category> label={t("addCategory")} value={undefined} placeholder={t("choose")} load={page => categories(context, page)} revision={revision} create={newCategory}
        hint={t("otherCategoriesHelp")}
        onChange={value => { if (value !== undefined && value.id !== group?.id) setExtras(current => current.some(item => item.id === value.id) ? current : [...current, { id: value.id, name: value.name }]); }} />}
      <Field label={t("barcode")} value={barcode} onChange={setBarcode} kind="code" hint={t("hint.barcode")} />
    </Section>
    <Section title={t("section.price")}>
      <Field label={t("price")} value={price} onChange={setPrice} kind="money" editable={canPrice} hint={canPrice ? t("hint.sellingPrice") : t("priceNeedsPermission")} />
      <Field label={t("cost")} value={cost} onChange={setCost} kind="money" editable={canPrice} hint={t("costHelp")} />
    </Section>
    <Section title={t("section.stock")}>
      <Field label={t("unit")} value={unit} onChange={setUnit} hint={t("hint.unit")} />
      {loaded === undefined ? <Toggle label={t("divisible")} value={divisible} onChange={setDivisible} hint={t("divisibleHelp")} /> : <Text style={s.muted}>{t("divisibleFixed")}</Text>}
      <Field label={t("minimum")} value={minimum} onChange={setMinimum} kind="quantity" hint={t("hint.minimum")} />
      {loaded === undefined && permissions.includes("inventory.adjust") && <Field label={t("openingQuantity")} value={opening} onChange={setOpening} kind="quantity" hint={t("openingHelp")} />}
    </Section>
  </Screen>;
}

/** Addition, damage/loss, opening stock or a shelf count, each with a reason and one stable movement ID. */
export function StockMoveScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { productId, kind } = useParams("stockMove"), { context, branchId } = useSession(), action = useAction(), request = useRequestId();
  const revision = useRevision(["products", "inventory"]);
  const item = useRecord(() => productRead(context, productId), [context, productId, revision]).value;
  const stock = useRecord(() => productStock(context, productId), [context, productId, revision]).value;
  const [quantity, setQuantity] = useState(""), [reason, setReason] = useState(kind === "OPENING_BALANCE" ? t("opening") : "");
  useLeaveGuard(quantity !== "");
  const title: TextKey = kind === "COUNT" ? "countStock" : kind === "DAMAGE" ? "damage" : kind === "OPENING_BALANCE" ? "opening" : "adjust";
  const save = (): void => action.run(() => {
    if (item === undefined) throw new FormProblem("notFound");
    if (reason.trim() === "") throw new FormProblem("reasonRequired");
    const units = quantityEntry(quantity, item.divisible);
    if (kind === "COUNT") return countStock(context, { productId, countedThousandths: units, reason: reason.trim(), branchId, requestId: request.current });
    if (units === 0) throw new FormProblem("quantityRequired");
    adjustStock(context, { id: request.current, productId, branchId, type: kind, quantity: kind === "DAMAGE" ? -units : units, reason: reason.trim(), occurredAt: new Date().toISOString() }, newIdOnDevice());
    return undefined;
  }, delta => { request.renew(); setQuantity(""); action.show({ tone: "success", key: delta === undefined ? "stockRecorded" : delta === 0 ? "countMatched" : "countRecorded", values: { delta: formatQuantity(delta ?? 0) } }); });
  return <Screen title={t(title)} eyebrow={item?.name} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={save} /></>}>
    {stock !== undefined && <Section><Facts items={[[t("stockNow"), `${formatQuantity(stock.onHandThousandths)} ${item?.unit ?? ""}`, stock.onHandThousandths < 0 ? "danger" : "strong"]]} /></Section>}
    <Section>
      <Field label={kind === "COUNT" ? t("observed") : t("quantity")} value={quantity} onChange={setQuantity} kind="quantity" autoFocus hint={kind === "COUNT" ? t("countHelp") : t("hint.stockQuantity")} />
      <Field label={t("reason")} value={reason} onChange={setReason} hint={t("hint.stockReason")} />
    </Section>
  </Screen>;
}

/** Newest-first stock movements for one product, bounded. */
export function StockHistoryScreen(): React.JSX.Element {
  const { t, language } = useText(), nav = useNav(), { productId } = useParams("stockHistory"), { context } = useSession(), revision = useRevision(["inventory"]);
  const item = useRecord(() => productRead(context, productId), [context, productId]).value;
  return <Screen title={t("history")} eyebrow={item?.name} onBack={nav.back} scroll={false}>
    <PagedList<Row> searchable={false} revision={revision} identify={row => String(row["id"])} load={page => stockHistory(context, productId, page)} empty={{ title: t("noMovements") }}
      render={row => { const quantity = Number(row["quantity"]);
        return <ListRow title={t(MOVEMENT_KEYS[String(row["type"])] ?? "history")} subtitle={[formatDate(String(row["occurred_at"]), language), typeof row["reason"] === "string" ? row["reason"] : undefined].filter(Boolean).join(" · ")}
          trailing={`${quantity > 0 ? "+" : ""}${formatQuantity(quantity)}`} trailingTone={quantity < 0 ? "danger" : "normal"} />; }} />
  </Screen>;
}

/** Categories list, reachable from Products. */
export function CategoriesScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { context } = useSession(), permissions = usePermissions(), revision = useRevision(["products"]), [archived, setArchived] = useState(false);
  return <Screen title={t("categories")} onBack={nav.back} scroll={false} actions={permissions.includes("products.create") ? <Button label={t("new")} variant="ghost" onPress={() => nav.push("categoryForm", {})} /> : undefined}>
    <PagedList<Category> revision={revision} identify={item => item.id} deps={[archived]} load={page => categories(context, { ...page, includeInactive: archived })}
      header={<Toggle label={t("showArchived")} value={archived} onChange={setArchived} hint={t("hint.showArchived")} />} empty={{ title: t("noCategories") }}
      render={item => <ListRow title={item.name} tag={item.active ? undefined : t("archived")} onPress={permissions.includes("products.edit") ? () => nav.push("categoryForm", { categoryId: item.id }) : undefined} />} />
  </Screen>;
}

/** Category creation, rename and archive/reactivation from the displayed version. */
export function CategoryFormScreen(): React.JSX.Element {
  const { t } = useText(), nav = useNav(), { categoryId } = useParams("categoryForm"), { context } = useSession(), permissions = usePermissions(), action = useAction(), request = useRequestId();
  const loaded = useMemo(() => { try { return categoryId === undefined ? undefined : categoryRead(context, categoryId); } catch { return undefined; } }, [context, categoryId]);
  const [name, setName] = useState(loaded?.name ?? "");
  useLeaveGuard(name !== (loaded?.name ?? ""));
  const write = (active: boolean): void => action.run(() => {
    if (name.trim() === "") throw new FormProblem("nameRequired");
    const now = new Date().toISOString();
    if (loaded === undefined) { if (categoryRead(context, request.current) === undefined) saveCategory(context, { id: request.current, name: name.trim(), active: true, createdAt: now, updatedAt: now }); return; }
    const stored = categoryRead(context, loaded.id); requireVersion(stored, loaded.updatedAt);
    if (!saveCategory(context, { ...stored!, name: name.trim(), active, updatedAt: nextVersion(stored!.updatedAt) })) throw new FormProblem("newerEdit");
  }, () => { request.renew(); nav.leave(); });
  return <Screen title={loaded === undefined ? t("newCategory") : t("editCategory")} onBack={nav.back} footer={<>{action.notice}<Button label={t("save")} onPress={() => write(loaded?.active ?? true)} /></>}>
    <Section><Field label={t("name")} value={name} onChange={setName} autoFocus hint={t("hint.categoryName")} /></Section>
    {loaded !== undefined && permissions.includes("products.archive") && <View style={{ gap: spacing.sm }}>
      <Button label={t(loaded.active ? "archive" : "restore")} variant={loaded.active ? "danger" : "secondary"} onPress={() => write(!loaded.active)} /></View>}
  </Screen>;
}
