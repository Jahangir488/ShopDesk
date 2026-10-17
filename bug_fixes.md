# Bug Fixes for Mohammad Hardware Shop System

## Issues Identified

### Issue 1: Bill Edit - Payment Validation Error
**Error:** "Payments already received are more than the new total"
**Location:** `server.mjs` line 575
**Problem:** When removing items from a bill, the validation prevents saving if the already-paid amount exceeds the new total.

### Issue 2: Sales Record Edits Don't Reflect on Invoice
**Location:** Bill printing function
**Problem:** The bill print function reads from the bill snapshot, not from the updated sales records.

### Issue 3: Missing Action Buttons After Return
**Location:** Sales table rendering
**Problem:** Returned items don't show Edit/Delete buttons in the Action column.

---

## Fix for Issue 1: Allow Bill Edits When Payment Exceeds New Total

**File:** `I:\Free Claude\Mohammad Hardware\server.mjs`
**Line:** 575

**Current Code:**
```javascript
if (old && total + 0.001 < old.paid) throw httpError(400, "Payments already received are more than the new total.");
```

**Replace With:**
```javascript
if (old && total + 0.001 < old.paid) {
  // Allow the edit but mark as overpaid - the bill will show a negative due
  console.log(`Bill ${editId}: Payments (${old.paid}) exceed new total (${total}). Allowing edit with negative due.`);
}
```

**Explanation:** This allows the bill to be saved even when payments exceed the new total. The system will correctly calculate a negative due amount (meaning credit owed to customer).

---

## Fix for Issue 2: Make Sales Edits Reflect on Invoice

The issue is that bills store a snapshot of items in the `lines` column, and the print function uses this snapshot instead of reading from the `sales` table.

**Option A: Update Bill Snapshot When Sales Are Edited (Recommended)**

**File:** `I:\Free Claude\Mohammad Hardware\server.mjs`

Find the sales edit endpoint (around line 800-900), and after updating a sale, add code to update the bill's snapshot:

```javascript
// After updating the sale record, update the bill snapshot
if (updated.bill_id) {
  const billSales = db.prepare(`
    SELECT product, qty, unit, (total / qty) as price, product_id 
    FROM sales 
    WHERE bill_id = ? AND is_return = 0
  `).all(updated.bill_id);
  
  const billSnapshot = JSON.stringify(billSales.map(s => ({
    productId: s.product_id,
    name: s.product,
    qty: s.qty,
    price: s.price,
    unit: s.unit
  })));
  
  db.prepare("UPDATE bills SET lines = ? WHERE id = ?").run(billSnapshot, updated.bill_id);
}
```

**Option B: Print from Sales Table Instead of Bill Snapshot**

**File:** `I:\Free Claude\Mohammad Hardware\app.js`

Find the `printBill` function (search for "function printBill") and modify it to read from the sales data instead of bill.lines:

Find this section:
```javascript
const lines = bill.lines || [];
```

Replace with:
```javascript
// Get actual sales records instead of snapshot
const billSales = data.sales.filter(s => s.bill_id === bill.id && !s.is_return);
const lines = billSales.map(s => ({
  name: s.product,
  qty: s.qty,
  price: s.total / s.qty,
  unit: s.unit
}));
```

---

## Fix for Issue 3: Show Action Buttons for Returned Items

**File:** `I:\Free Claude\Mohammad Hardware\app.js`

Find where sales are rendered (search for "#sales-table" or "renderSales"), around line 1950-2000:

**Current Code Pattern:**
```javascript
$("#sales-table").innerHTML = data.sales.map((sale, i) => {
  const actions = canEdit && !sale.is_return ? `<td><button...>Edit</button><button...>Delete</button></td>` : `<td></td>`;
  return `<tr>...${actions}</tr>`;
}).join("");
```

**Problem:** The condition `!sale.is_return` prevents showing buttons for returned items.

**Replace With:**
```javascript
$("#sales-table").innerHTML = data.sales.map((sale, i) => {
  // Show edit/delete for all sales if user has permission
  const actions = canEdit ? `<td><button class="user-action" data-action="edit-sale" data-id="${sale.id}">Edit</button><button class="user-action danger" data-action="delete-sale" data-id="${sale.id}">Delete</button></td>` : `<td></td>`;
  return `<tr>...${actions}</tr>`;
}).join("");
```

**Explanation:** Remove the `!sale.is_return` check so action buttons appear for all sales, including returned items.

---

## Step-by-Step Application Instructions

### For Issue 1:
1. Open `I:\Free Claude\Mohammad Hardware\server.mjs`
2. Go to line 575
3. Replace the error throw with the logging statement shown above
4. Save the file
5. Restart your server

### For Issue 2 (Choose Option A or B):
**Option A:**
1. Open `I:\Free Claude\Mohammad Hardware\server.mjs`
2. Find the PUT/PATCH endpoint for `/api/sales/:id` (search for "app.put" and "sales")
3. Add the bill snapshot update code shown above
4. Save and restart server

**Option B:**
1. Open `I:\Free Claude\Mohammad Hardware\app.js`
2. Search for `function printBill`
3. Modify the lines loading as shown above
4. Save and refresh browser

### For Issue 3:
1. Open `I:\Free Claude\Mohammad Hardware\app.js`
2. Search for `#sales-table` and find where sales are rendered
3. Remove the `!sale.is_return` condition from action buttons
4. Save and refresh browser

---

## Testing After Fixes

### Test Issue 1:
1. Create a bill with 2 items totaling 3,000 BDT
2. Receive full payment (3,000 BDT)
3. Edit the bill and remove 1 item (new total 2,800 BDT)
4. Should save successfully (due will show -200 BDT)

### Test Issue 2:
1. Create a bill with an item
2. Print the bill and note the quantity/price
3. Edit the sale record and change quantity or price
4. Print the bill again
5. Verify the changes appear on the printed bill

### Test Issue 3:
1. Go to Sales History
2. Find a returned item (marked with "Return")
3. Verify Edit and Delete buttons appear in the Action column
4. Test clicking Edit to ensure it works

---

## Issue 4: Bill Edit Refund Checkbox Doesn't Show Refund Due on Print

**Location:** `app.js` bill print template (`billHtml`) and `server.mjs` bill update
**Problem:** On the bill edit page, checking "Process refund to customer" saved correctly but the printed receipt never showed the refund due amount.

**Root cause:** The print template only rendered a "REFUND DUE" row when `bill.due < 0`, but the server clamps `due` to `Math.max(0, ...)` (`server.mjs` `billById`), so `due` can never be negative. The correct refund-due value was already computed as `customerCredit` (`paid - netTotal - refunded`) but the print ignored it. Also, the server ignored the adjusted refund amount entered in the editor.

**Fixes applied (V14):**
1. `app.js` `billHtml`: print "REFUND DUE" when `Number(bill.customerCredit) > 0`, using `money(bill.customerCredit)`.
2. `server.mjs` `saveBill`: when the refund checkbox is checked, the full overpayment stays owed to the customer; if a lower refund amount is entered, payments are adjusted to `new total + refund amount` so the rest is left as store credit.
3. `app.js` editor: refund auto-calculation now subtracts previously refunded amounts (`editing.refunded`) so it doesn't overstate the remaining refund.

### Test Issue 4:
1. Create a bill with 2 items, receive full payment
2. Edit the bill, remove 1 item (new total is lower than paid)
3. Check "Process refund to customer", save
4. Print the bill from the Bills list — a red "REFUND DUE" row now shows the overpayment
5. Repeat with a lower refund amount — the print shows exactly that amount
6. Repeat with the checkbox unchecked — no refund row appears and paid matches the new total

---

## Additional Notes

- Always backup your database before making changes
- Test each fix individually before moving to the next
- If you encounter any issues, you can revert the changes

