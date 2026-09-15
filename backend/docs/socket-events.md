# Socket.IO Events Specification

## Connection & Authentication

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `connect` | `{ tenantId: string, authToken: string }` | Initial connection with tenant context and JWT |
| `authenticate` | `{ authToken: string }` | Re-authenticate on token refresh |
| `join_room` | `{ room: string }` | Join a specific room (e.g., `kitchen`, `pos`, `online`) |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `authenticated` | `{ success: boolean, user: User, tenant: Tenant }` | Auth result |
| `auth_error` | `{ error: string }` | Authentication failed |
| `session_expired` | `{}` | Token expired, reconnect needed |

---

## Room Structure

Each tenant gets isolated rooms:
- `{tenantId}:pos` — POS terminals
- `{tenantId}:kitchen` — Kitchen displays
- `{tenantId}:online` — Online order screen
- `{tenantId}:admin` — Admin panel dashboards
- `{tenantId}:all` — Broadcast to all tenant connections

---

## Menu & Availability Events

### Server → Client (Broadcast to `pos` and `online` rooms)
| Event | Payload | Description |
|-------|---------|-------------|
| `menu:updated` | `{ categoryId?: string, itemId?: string, action: 'create' \| 'update' \| 'delete' }` | Menu changed |
| `availability:changed` | `{ itemId: string, isAvailable: boolean, reason: 'STOCK_OUT' \| 'MANUAL' \| 'SCHEDULE' }` | Item availability changed |
| `price:changed` | `{ itemId: string, price: number }` | Price updated |

---

## Inventory Events

### Server → Client (Broadcast to `pos`, `online`, `admin` rooms)
| Event | Payload | Description |
|-------|---------|-------------|
| `inventory:low_stock` | `{ ingredientId: string, name: string, currentStock: number, threshold: number }` | Stock below threshold |
| `inventory:updated` | `{ ingredientId: string, currentStock: number, movementType: StockMovementType }` | Stock level changed |
| `inventory:item_86d` | `{ itemId: string, reason: string }` | Item marked unavailable (86'd) |

---

## Order Events (POS Orders - P-)

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `order:create` | `{ items: [], type: OrderType, tableId?: string, customer?: {}, notes?: string }` | Create new order |
| `order:update` | `{ orderId: string, items: [], discount?: number }` | Update existing order |
| `order:park` | `{ orderId: string, cartData: {} }` | Park/hold order |
| `order:resume` | `{ orderId: string }` | Resume parked order |
| `order:cancel` | `{ orderId: string, reason: string }` | Cancel order |
| `order:payment_initiate` | `{ orderId: string, method: PaymentMethod, provider: string }` | Start payment |
| `order:payment_confirm` | `{ orderId: string, paymentId: string }` | Confirm manual payment received |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `order:created` | `{ order: Order, orderNumber: string }` | Order created successfully |
| `order:error` | `{ error: string, code: string }` | Order operation failed |
| `order:payment_status` | `{ orderId: string, status: PaymentStatus, method: PaymentMethod, transactionId?: string }` | Payment status update |
| `order:paid` | `{ orderId: string, orderNumber: string, total: number }` | Order fully paid, send to kitchen |
| `order:print_ready` | `{ orderId: string, receiptData: ReceiptJSON }` | Ready to print receipt |

---

## Kitchen Display Events

### Server → Client (Broadcast to `kitchen` room)
| Event | Payload | Description |
|-------|---------|-------------|
| `kitchen:new_order` | `{ order: OrderWithItems, source: 'POS' \| 'ONLINE', ageSeconds: number }` | New paid order arrived |
| `kitchen:order_update` | `{ orderId: string, status: OrderItemStatus, timestamps: { preparingAt?: Date, readyAt?: Date } }` | Order status changed |
| `kitchen:order_cancelled` | `{ orderId: string, reason: string }` | Order cancelled (kitchen should stop) |
| `kitchen:alert` | `{ type: 'RUSH' \| 'DELAYED' \| 'MODIFICATION', orderId: string, message: string }` | Special alert |

### Client → Server (From KDS)
| Event | Payload | Description |
|-------|---------|-------------|
| `kitchen:acknowledge` | `{ orderId: string }` | Chef acknowledged new order |
| `kitchen:start_preparing` | `{ orderId: string, station?: string }` | Started preparing |
| `kitchen:mark_ready` | `{ orderId: string }` | Order ready for pickup/delivery |
| `kitchen:update_delay` | `{ orderId: string, delayMinutes: number }` | Update prep time estimate |

---

## Online Order Events

### Server → Client (Broadcast to `pos` room for acceptance)
| Event | Payload | Description |
|-------|---------|-------------|
| `online:new_order` | `{ order: OnlineOrderWithItems, requiresAcceptance: boolean }` | New online order received |
| `online:order_accepted` | `{ orderId: string, acceptedAt: Date }` | Restaurant accepted order |
| `online:order_rejected` | `{ orderId: string, reason: string, refundInitiated: boolean }` | Restaurant rejected order |
| `online:status_changed` | `{ orderId: string, status: OnlineOrderStatus }` | Status update for customer page |

### Client → Server (From POS/Admin)
| Event | Payload | Description |
|-------|---------|-------------|
| `online:accept` | `{ orderId: string }` | Accept online order |
| `online:reject` | `{ orderId: string, reason: string, refundFlag: boolean }` | Reject with reason |
| `online:update_status` | `{ orderId: string, status: OnlineOrderStatus }` | Update order status |

---

## Cart & Parked Orders Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `cart:save` | `{ cartData: {}, identifier: string }` | Save cart state (offline sync) |
| `cart:retrieve` | `{ identifier: string }` | Get saved cart |
| `parked:list` | `{}` | List all parked carts |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `cart:restored` | `{ cartData: {} }` | Cart restored from storage |
| `parked:carts` | `{ carts: ParkedCart[] }` | List of parked carts |
| `parked:released` | `{ orderId: string }` | Parked cart converted to order |

---

## Shift Management Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `shift:open` | `{ openingBalance: number, notes?: string }` | Open cashier shift |
| `shift:close` | `{ closingBalance: number, notes?: string }` | Close shift with count |
| `shift:update` | `{ cashInDrawer: number }` | Periodic cash update |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `shift:opened` | `{ shift: Shift }` | Shift opened successfully |
| `shift:closed` | `{ shift: Shift, overShort: number }` | Shift closed with reconciliation |
| `shift:conflict` | `{ message: string }` | Another terminal opened shift |

---

## Printer Events

### Client → Server
| Event | Payload | Description |
|-------|---------|-------------|
| `printer:receipt` | `{ orderId: string, copies?: number }` | Print receipt |
| `printer:kitchen_ticket` | `{ orderId: string, station?: string }` | Print kitchen ticket |
| `printer:test` | `{ printerId: string }` | Test print |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `printer:queued` | `{ jobId: string, status: 'queued' }` | Print job queued |
| `printer:success` | `{ jobId: string }` | Print successful |
| `printer:error` | `{ jobId: string, error: string }` | Print failed |

---

## Dashboard & Analytics Events

### Server → Client (Broadcast to `admin` room)
| Event | Payload | Description |
|-------|---------|-------------|
| `dashboard:sales_update` | `{ todayRevenue: number, orderCount: number, avgTicket: number, split: { pos: number, online: number } }` | Live sales metrics |
| `dashboard:live_orders` | `{ activeOrders: number, pending: number, preparing: number, ready: number }` | Live order counts |
| `dashboard:top_sellers` | `{ items: [{ itemId, name, quantity, revenue }] }` | Top selling items |
| `dashboard:hourly_heatmap` | `{ hours: [{ hour, count, revenue }] }` | Hourly distribution |

---

## Alerts & Notifications

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `alert:inventory` | `{ type: 'LOW_STOCK' \| 'OUT_OF_STOCK', ingredient: Ingredient }` | Inventory alert |
| `alert:payment_failed` | `{ orderId: string, reason: string }` | Payment failure |
| `alert:system` | `{ type: 'INFO' \| 'WARNING' \| 'ERROR', message: string }` | System-wide alert |
| `alert:order_delayed` | `{ orderId: string, delayMinutes: number }` | Order taking too long |

---

## Offline Sync Events

### Client → Server (On reconnection)
| Event | Payload | Description |
|-------|---------|-------------|
| `sync:pending_orders` | `{ orders: QueuedOrder[] }` | Orders queued offline |
| `sync:last_seen` | `{ timestamp: Date }` | Last known server state |
| `sync:request_delta` | `{ since: Date }` | Request changes since timestamp |

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `sync:acknowledged` | `{ processedOrderIds: string[], failed: [{ id, reason }] }` | Sync result |
| `sync:delta` | `{ orders: Order[], menu: MenuItem[], inventory: Ingredient[] }` | Changes since timestamp |
| `sync:conflict` | `{ entityType: string, entityId: string, localVersion: {}, serverVersion: {} }` | Conflict detected |

---

## Superadmin Events (Multi-tenant)

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `platform:tenant_created` | `{ tenantId: string, name: string }` | New tenant signed up |
| `platform:tenant_suspended` | `{ tenantId: string, reason: string }` | Tenant suspended |
| `platform:usage_alert` | `{ tenantId: string, metric: string, limit: number, current: number }` | Tenant approaching limits |

---

## Event Naming Convention

- Use colon notation for namespacing: `entity:action`
- Past tense for server broadcasts: `order:created`, `payment:received`
- Imperative for client actions: `order:create`, `payment:initiate`
- All payloads are JSON-serializable
- Include tenantId in server-side room management, not in event payloads
- Timestamps in ISO 8601 format

## Security Notes

1. All events must be authenticated before processing
2. Tenant isolation enforced at socket room level
3. Rate limiting per connection
4. Idempotency keys required for payment and order creation events
5. Audit log entry for state-changing events
