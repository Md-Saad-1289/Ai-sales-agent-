import { useEffect, useState } from 'react';
import { Search, ShoppingBag, X } from 'lucide-react';
import { api } from '../lib/api';
import type { Order, OrderStatus } from '../types';

const STATUS_OPTIONS: OrderStatus[] = [
  'pending',
  'confirmed',
  'processing',
  'shipped',
  'delivered',
  'cancelled',
];

function statusTextColor(status: OrderStatus): string {
  switch (status) {
    case 'confirmed':
    case 'delivered':
      return 'text-emerald-700';
    case 'pending':
      return 'text-amber-700';
    case 'cancelled':
      return 'text-red-700';
    default:
      return 'text-blue-700';
  }
}

export function OrdersPage() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [currency, setCurrency] = useState('BDT');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<OrderStatus | 'all'>('all');
  const [search, setSearch] = useState('');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);

  async function loadOrders() {
    setLoading(true);
    setError(null);
    try {
      const [ordRes, setRes] = await Promise.all([api.listOrders(), api.getSettings()]);
      setOrders(ordRes.orders);
      setCurrency(setRes.settings.currency || 'BDT');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load orders.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadOrders();
  }, []);

  async function handleStatusChange(orderId: string, nextStatus: OrderStatus) {
    setUpdatingId(orderId);
    setError(null);
    try {
      const res = await api.updateOrderStatus(orderId, nextStatus);
      setOrders((prev) => prev.map((o) => (o._id === orderId ? res.order : o)));
      if (selectedOrder?._id === orderId) {
        setSelectedOrder(res.order);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update order status.');
    } finally {
      setUpdatingId(null);
    }
  }

  const filtered = orders.filter((o) => {
    if (statusFilter !== 'all' && o.status !== statusFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      return (
        o.orderNumber.toLowerCase().includes(q) ||
        o.customerName.toLowerCase().includes(q) ||
        o.phoneNumber.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <div className="space-y-5">
      {/* Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search order #, customer, phone..."
            className="pl-8.5 pr-3 py-2 text-[13px] bg-white border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-400 w-72 transition-colors focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-slate-100 border border-slate-200/80 rounded-lg">
          <button
            type="button"
            onClick={() => setStatusFilter('all')}
            className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors cursor-pointer ${
              statusFilter === 'all' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            All
          </button>
          {STATUS_OPTIONS.map((st) => (
            <button
              key={st}
              type="button"
              onClick={() => setStatusFilter(st)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md capitalize transition-colors cursor-pointer ${
                statusFilter === st ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-slate-200/90 rounded-xl overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
        {loading ? (
          <div className="p-6 space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-11 bg-slate-100 rounded-lg animate-pulse" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <ShoppingBag className="w-6 h-6 text-slate-300 mx-auto mb-2.5" />
            <p className="text-sm font-medium text-slate-700">
              {orders.length === 0 ? 'No orders yet' : 'No matching orders'}
            </p>
            <p className="text-xs text-slate-500 mt-1 max-w-sm mx-auto">
              {orders.length === 0
                ? 'Orders confirmed by customers in Messenger will appear here automatically.'
                : 'Try clearing the search query or selecting another status tab.'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto subtle-scroll">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200/90 text-xs font-medium text-slate-500 bg-slate-50/70">
                  <th className="py-3 px-5">Order</th>
                  <th className="py-3 px-5">Customer</th>
                  <th className="py-3 px-5">Items</th>
                  <th className="py-3 px-5 text-right">Total</th>
                  <th className="py-3 px-5">Status</th>
                  <th className="py-3 px-5">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/80 text-sm">
                {filtered.map((order) => (
                  <tr
                    key={order._id}
                    onClick={() => setSelectedOrder(order)}
                    className="hover:bg-slate-50/70 transition-colors cursor-pointer"
                  >
                    <td className="py-3.5 px-5 font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                      {order.orderNumber}
                    </td>
                    <td className="py-3.5 px-5">
                      <p className="text-[13px] font-medium text-slate-900">{order.customerName}</p>
                      <p className="text-xs text-slate-500 font-mono tabular-nums mt-0.5">{order.phoneNumber}</p>
                    </td>
                    <td className="py-3.5 px-5 text-xs text-slate-700 max-w-xs truncate">
                      {order.items.map((i) => `${i.productName} × ${i.quantity}`).join(', ')}
                    </td>
                    <td className="py-3.5 px-5 text-right font-mono text-xs font-medium text-slate-900 tabular-nums whitespace-nowrap">
                      {currency} {order.totalAmount}
                    </td>
                    <td className="py-3.5 px-5 whitespace-nowrap" onClick={(e) => e.stopPropagation()}>
                      <select
                        value={order.status}
                        disabled={updatingId === order._id}
                        onChange={(e) => void handleStatusChange(order._id, e.target.value as OrderStatus)}
                        className={`text-xs font-medium capitalize bg-white border border-slate-300 rounded-md px-2.5 py-1 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 ${statusTextColor(order.status)}`}
                      >
                        {STATUS_OPTIONS.map((st) => (
                          <option key={st} value={st} className="text-slate-900">
                            {st}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="py-3.5 px-5 text-xs text-slate-500 font-mono tabular-nums whitespace-nowrap">
                      {new Date(order.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Order Detail Drawer */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 bg-slate-900/25 backdrop-blur-[1px] flex justify-end">
          <div className="w-full max-w-md bg-white h-full border-l border-slate-200 flex flex-col shadow-xl">
            <div className="px-6 py-4 border-b border-slate-200/80 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-slate-900 font-mono tabular-nums">
                  {selectedOrder.orderNumber}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  {new Date(selectedOrder.createdAt).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSelectedOrder(null)}
                aria-label="Close order detail"
                className="p-1.5 text-slate-400 hover:text-slate-700 rounded-md cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-6 text-sm subtle-scroll">
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1.5">Order Status</p>
                <select
                  value={selectedOrder.status}
                  disabled={updatingId === selectedOrder._id}
                  onChange={(e) =>
                    void handleStatusChange(selectedOrder._id, e.target.value as OrderStatus)
                  }
                  className="w-full px-3 py-2 text-sm capitalize bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                >
                  {STATUS_OPTIONS.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
              </div>

              <div className="border-t border-slate-200/80 pt-5 space-y-1.5">
                <p className="text-xs font-medium text-slate-500">Customer & Delivery</p>
                <p className="font-medium text-slate-900">{selectedOrder.customerName}</p>
                <p className="text-xs font-mono text-slate-700 tabular-nums">{selectedOrder.phoneNumber}</p>
                <p className="text-xs text-slate-600 leading-relaxed">{selectedOrder.deliveryAddress}</p>
                <p className="text-xs text-slate-400 font-mono pt-1">PSID: {selectedOrder.messengerId}</p>
              </div>

              <div className="border-t border-slate-200/80 pt-5 space-y-3">
                <p className="text-xs font-medium text-slate-500">Order Summary</p>
                <div className="space-y-2">
                  {selectedOrder.items.map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between text-xs">
                      <span className="text-slate-800">
                        {item.productName} × {item.quantity}
                      </span>
                      <span className="font-mono text-slate-900 tabular-nums">
                        {currency} {item.lineTotal}
                      </span>
                    </div>
                  ))}
                </div>
                <div className="border-t border-slate-100 pt-3 space-y-1.5 text-xs">
                  <div className="flex justify-between text-slate-500">
                    <span>Subtotal</span>
                    <span className="font-mono tabular-nums">
                      {currency} {selectedOrder.subtotal}
                    </span>
                  </div>
                  <div className="flex justify-between text-slate-500">
                    <span>Delivery charge</span>
                    <span className="font-mono tabular-nums">
                      {currency} {selectedOrder.deliveryCharge}
                    </span>
                  </div>
                  <div className="flex justify-between font-semibold text-slate-900 pt-1.5 border-t border-slate-100">
                    <span>Total</span>
                    <span className="font-mono tabular-nums">
                      {currency} {selectedOrder.totalAmount}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
