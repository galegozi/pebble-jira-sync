async function request(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    throw new Error(payload?.error || payload?.details || "Request failed");
  }

  return payload;
}

const loginCard = document.getElementById("login-card");
const boardCard = document.getElementById("board-card");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const boardSubtitle = document.getElementById("board-subtitle");
const statusOrder = document.getElementById("status-order");
const boardGrid = document.getElementById("board-grid");
const logoutButton = document.getElementById("logout-button");

function renderBoard(board) {
  boardSubtitle.textContent = `${board.email} · ${board.baseUrl}`;
  statusOrder.innerHTML = "";
  boardGrid.innerHTML = "";

  board.statuses.forEach((status, index) => {
    const item = document.createElement("li");
    item.className = "status-order-item";
    item.innerHTML = `
      <span>${status}</span>
      <div class="status-actions">
        <button class="secondary" ${index === 0 ? "disabled" : ""} data-direction="up">↑</button>
        <button class="secondary" ${index === board.statuses.length - 1 ? "disabled" : ""} data-direction="down">↓</button>
      </div>
    `;

    item.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", async () => {
        const nextOrder = [...board.statuses];
        const swapOffset = button.dataset.direction === "up" ? -1 : 1;
        const swapIndex = index + swapOffset;
        [nextOrder[index], nextOrder[swapIndex]] = [nextOrder[swapIndex], nextOrder[index]];
        const nextBoard = await request("/api/status-order", {
          method: "PUT",
          body: JSON.stringify({ statuses: nextOrder }),
        });
        renderBoard({ ...board, ...nextBoard, statuses: nextBoard.statuses });
      });
    });

    statusOrder.appendChild(item);
  });

  board.issuesByStatus.forEach((group) => {
    const column = document.createElement("section");
    column.className = "status-column";
    column.innerHTML = `<h3>${group.status}</h3>`;

    if (!group.issues.length) {
      const emptyState = document.createElement("p");
      emptyState.className = "empty-state";
      emptyState.textContent = "No items in this status.";
      column.appendChild(emptyState);
    } else {
      group.issues.forEach((issue) => {
        const card = document.createElement("article");
        card.className = "issue-card";
        card.innerHTML = `<strong>${issue.key}</strong><span>${issue.summary}</span>`;
        column.appendChild(card);
      });
    }

    boardGrid.appendChild(column);
  });

  loginCard.classList.add("hidden");
  boardCard.classList.remove("hidden");
}

async function refreshBoard() {
  const payload = await request("/api/status-board");

  if (!payload.authenticated) {
    loginCard.classList.remove("hidden");
    boardCard.classList.add("hidden");
    document.getElementById("jql").value = payload.defaultJql || "";
    return;
  }

  renderBoard(payload);
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginMessage.textContent = "";

  try {
    const formData = new FormData(loginForm);
    const payload = await request("/api/session", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(formData.entries())),
    });
    renderBoard(payload);
  } catch (error) {
    loginMessage.textContent = error.message;
  }
});

logoutButton.addEventListener("click", async () => {
  await request("/api/session", { method: "DELETE" });
  loginForm.reset();
  await refreshBoard();
});

refreshBoard().catch((error) => {
  loginMessage.textContent = error.message;
});
