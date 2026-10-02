import type { PricedCart } from "../index";
import styles from "./app.module.css";
import { formatMoney } from "./money";

// The picker's footer: cart summary plus a Checkout button that is always there — disabled, not
// hidden, while the cart is empty, while an order is being opened, or when there is no host to
// check out through (standalone mode). The button carries the item count it will check out.
export function CartFooter({ cart, canCheckout, checkingOut, onCheckout }: {
  cart: PricedCart;
  canCheckout: boolean;
  checkingOut: boolean;
  onCheckout: () => void;
}) {
  const n = cart.itemCount;
  return (
    <div className={styles.footer}>
      <span className={styles.summary}>
        {n > 0 ? `🛒 ${n} in cart · ${formatMoney(cart.total, cart.currency)}` : "🛒 Cart is empty"}
      </span>
      <button
        className={styles.checkout}
        disabled={!canCheckout || n === 0 || checkingOut}
        aria-label={n > 0 && !checkingOut ? `Checkout ${n} ${n === 1 ? "item" : "items"}` : undefined}
        onClick={onCheckout}
      >
        {checkingOut ? "Opening…" : n > 0 ? `Checkout (${n})` : "Checkout"}
      </button>
    </div>
  );
}
