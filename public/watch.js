async function watchRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    ...options,
  });
  const payload = response.headers.get("content-type")?.includes("application/json")
    ? await response.json()
    : null;

  if (!response.ok) {
    throw new Error(payload?.error || payload?.details || "Request failed");
  }

  return payload;
}

const watchGroups = document.getElementById("watch-groups");
const watchMessage = document.getElementById("watch-message");

async function loadWatchBoard() {
  const payload = await watchRequest("/api/status-board");
  watchGroups.innerHTML = "";

  if (!payload.authenticated) {
    watchMessage.textContent = "Connect Jira in the phone view first.";
    return;
  }

  watchMessage.textContent = "Tap an issue to change its status.";

  payload.issuesByStatus.forEach((group) => {
    const wrapper = document.createElement("section");
    wrapper.className = "watch-group";
    wrapper.innerHTML = `<h2>${group.status}</h2>`;

    if (!group.issues.length) {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "No issues";
      wrapper.appendChild(empty);
    }

    group.issues.forEach((issue) => {
      const card = document.createElement("article");
      card.className = "watch-issue";
      card.innerHTML = `
        <strong>${issue.key}</strong>
        <span>${issue.summary}</span>
        <button>Change status</button>
        <div class="watch-transition-picker hidden"></div>
      `;

      const picker = card.querySelector(".watch-transition-picker");
      card.querySelector("button").addEventListener("click", async () => {
        const payload = await watchRequest(`/api/issues/${issue.key}/transitions`);
        picker.innerHTML = "";
        const select = document.createElement("select");
        payload.transitions.forEach((transition) => {
          const option = document.createElement("option");
          option.value = transition.name;
          option.textContent = transition.name;
          select.appendChild(option);
        });
        const confirmButton = document.createElement("button");
        confirmButton.textContent = "Update";
        confirmButton.addEventListener("click", async () => {
          await watchRequest(`/api/issues/${issue.key}/status`, {
            method: "POST",
            body: JSON.stringify({ status: select.value }),
          });
          await loadWatchBoard();
        });
        picker.append(select, confirmButton);
        picker.classList.remove("hidden");
      });

      wrapper.appendChild(card);
    });

    watchGroups.appendChild(wrapper);
  });
}

loadWatchBoard().catch((error) => {
  watchMessage.textContent = error.message;
});
