import styles from "./app.module.css";

// Shown under the grant card, which takes over the widget when a grant tool result arrives: the
// way back to the product picker, without asking the agent to call browse-products again.
export function ShowProducts({ itemCount, onShow }: { itemCount: number; onShow: () => void }) {
  return (
    <div className={styles.footer}>
      <span className={styles.summary}>{itemCount > 0 ? `🛒 ${itemCount} in cart` : ""}</span>
      <button className={styles.showProducts} onClick={onShow}>
        🛍 Show products
      </button>
    </div>
  );
}
