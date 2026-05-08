#include <pebble.h>

/* ── Message keys (must match appinfo.json appKeys and pkjs) ── */
#define KEY_CMD           0
#define KEY_INDEX         1
#define KEY_ISSUE_KEY     2
#define KEY_ISSUE_SUMMARY 3
#define KEY_ISSUE_STATUS  4
#define KEY_TRANS_ID      5
#define KEY_TRANS_NAME    6
#define KEY_MSG           7

/* ── Commands ── */
#define CMD_GET_ISSUES  0
#define CMD_ISSUE_DATA  1
#define CMD_ISSUES_DONE 2
#define CMD_GET_TRANS   3
#define CMD_TRANS_DATA  4
#define CMD_TRANS_DONE  5
#define CMD_APPLY_TRANS 6
#define CMD_SUCCESS     7
#define CMD_ERROR       8

#define MAX_ISSUES      20
#define MAX_TRANSITIONS 10
#define STR_LEN         64

/* ── Data types ── */
typedef struct {
  char key[STR_LEN];
  char summary[STR_LEN];
  char status[STR_LEN];
} Issue;

typedef struct {
  char id[STR_LEN];
  char name[STR_LEN];
} Transition;

/* ── Global state ── */
static Issue      s_issues[MAX_ISSUES];
static int        s_issue_count = 0;
static int        s_selected_issue = 0;

static Transition s_transitions[MAX_TRANSITIONS];
static int        s_transition_count = 0;

/* ── Issues window ── */
static Window    *s_issues_window;
static MenuLayer *s_issues_menu;
static TextLayer *s_issues_status;

/* ── Transitions window ── */
static Window    *s_trans_window;
static MenuLayer *s_trans_menu;
static TextLayer *s_trans_status;

/* ── Forward declarations ── */
static void issues_select(MenuLayer *ml, MenuIndex *idx, void *ctx);
static void trans_select(MenuLayer *ml, MenuIndex *idx, void *ctx);
static void request_issues(void);

/* ════════════════════════════════════════════════════════════════
   Issues window
   ════════════════════════════════════════════════════════════════ */

static uint16_t issues_num_sections(MenuLayer *ml, void *ctx) {
  return 1;
}

static uint16_t issues_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  return (s_issue_count > 0) ? (uint16_t)s_issue_count : 1;
}

static void issues_draw_row(GContext *ctx, const Layer *layer,
                            MenuIndex *idx, void *context) {
  if (s_issue_count == 0) {
    menu_cell_basic_draw(ctx, layer, "No issues found", NULL, NULL);
  } else {
    Issue *issue = &s_issues[idx->row];
    menu_cell_basic_draw(ctx, layer, issue->key, issue->summary, NULL);
  }
}

static void issues_window_load(Window *window) {
  Layer *root   = window_get_root_layer(window);
  GRect  bounds = layer_get_bounds(root);

  s_issues_status = text_layer_create(bounds);
  text_layer_set_text_alignment(s_issues_status, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_issues_status, GTextOverflowModeWordWrap);
  text_layer_set_text(s_issues_status, "Loading issues...");
  layer_add_child(root, text_layer_get_layer(s_issues_status));

  s_issues_menu = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_issues_menu, NULL, (MenuLayerCallbacks){
    .get_num_sections = issues_num_sections,
    .get_num_rows     = issues_num_rows,
    .draw_row         = issues_draw_row,
    .select_click     = issues_select,
  });
  menu_layer_set_click_config_onto_window(s_issues_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_issues_menu));
  layer_set_hidden(menu_layer_get_layer(s_issues_menu), true);
}

static void issues_window_unload(Window *window) {
  menu_layer_destroy(s_issues_menu);
  text_layer_destroy(s_issues_status);
  s_issues_menu   = NULL;
  s_issues_status = NULL;
}

/* ════════════════════════════════════════════════════════════════
   Transitions window
   ════════════════════════════════════════════════════════════════ */

static uint16_t trans_num_sections(MenuLayer *ml, void *ctx) {
  return 1;
}

static uint16_t trans_num_rows(MenuLayer *ml, uint16_t section, void *ctx) {
  return (s_transition_count > 0) ? (uint16_t)s_transition_count : 1;
}

static void trans_draw_row(GContext *ctx, const Layer *layer,
                           MenuIndex *idx, void *context) {
  if (s_transition_count == 0) {
    menu_cell_basic_draw(ctx, layer, "No transitions", NULL, NULL);
  } else {
    menu_cell_basic_draw(ctx, layer, s_transitions[idx->row].name, NULL, NULL);
  }
}

static void trans_window_load(Window *window) {
  Layer *root   = window_get_root_layer(window);
  GRect  bounds = layer_get_bounds(root);

  s_trans_status = text_layer_create(bounds);
  text_layer_set_text_alignment(s_trans_status, GTextAlignmentCenter);
  text_layer_set_overflow_mode(s_trans_status, GTextOverflowModeWordWrap);
  text_layer_set_text(s_trans_status, "Loading transitions...");
  layer_add_child(root, text_layer_get_layer(s_trans_status));

  s_trans_menu = menu_layer_create(bounds);
  menu_layer_set_callbacks(s_trans_menu, NULL, (MenuLayerCallbacks){
    .get_num_sections = trans_num_sections,
    .get_num_rows     = trans_num_rows,
    .draw_row         = trans_draw_row,
    .select_click     = trans_select,
  });
  menu_layer_set_click_config_onto_window(s_trans_menu, window);
  layer_add_child(root, menu_layer_get_layer(s_trans_menu));
  layer_set_hidden(menu_layer_get_layer(s_trans_menu), true);
}

static void trans_window_unload(Window *window) {
  menu_layer_destroy(s_trans_menu);
  text_layer_destroy(s_trans_status);
  s_trans_menu   = NULL;
  s_trans_status = NULL;
}

/* ════════════════════════════════════════════════════════════════
   Message handling
   ════════════════════════════════════════════════════════════════ */

static void inbox_received(DictionaryIterator *iter, void *ctx) {
  Tuple *cmd_t = dict_find(iter, KEY_CMD);
  if (!cmd_t) return;
  int cmd = (int)cmd_t->value->int32;

  switch (cmd) {
    case CMD_ISSUE_DATA: {
      if (s_issue_count >= MAX_ISSUES) break;
      Tuple *k  = dict_find(iter, KEY_ISSUE_KEY);
      Tuple *s  = dict_find(iter, KEY_ISSUE_SUMMARY);
      Tuple *st = dict_find(iter, KEY_ISSUE_STATUS);
      Issue *issue = &s_issues[s_issue_count++];
      if (k)  { strncpy(issue->key,     k->value->cstring,  STR_LEN - 1); issue->key[STR_LEN - 1]     = '\0'; }
      if (s)  { strncpy(issue->summary, s->value->cstring,  STR_LEN - 1); issue->summary[STR_LEN - 1] = '\0'; }
      if (st) { strncpy(issue->status,  st->value->cstring, STR_LEN - 1); issue->status[STR_LEN - 1]  = '\0'; }
      break;
    }

    case CMD_ISSUES_DONE:
      if (s_issues_status) {
        layer_set_hidden(text_layer_get_layer(s_issues_status), true);
      }
      if (s_issues_menu) {
        layer_set_hidden(menu_layer_get_layer(s_issues_menu), false);
        menu_layer_reload_data(s_issues_menu);
      }
      break;

    case CMD_TRANS_DATA: {
      if (s_transition_count >= MAX_TRANSITIONS) break;
      Tuple *id = dict_find(iter, KEY_TRANS_ID);
      Tuple *nm = dict_find(iter, KEY_TRANS_NAME);
      Transition *t = &s_transitions[s_transition_count++];
      if (id) { strncpy(t->id,   id->value->cstring, STR_LEN - 1); t->id[STR_LEN - 1]   = '\0'; }
      if (nm) { strncpy(t->name, nm->value->cstring, STR_LEN - 1); t->name[STR_LEN - 1] = '\0'; }
      break;
    }

    case CMD_TRANS_DONE:
      if (s_trans_status) {
        layer_set_hidden(text_layer_get_layer(s_trans_status), true);
      }
      if (s_trans_menu) {
        layer_set_hidden(menu_layer_get_layer(s_trans_menu), false);
        menu_layer_reload_data(s_trans_menu);
      }
      break;

    case CMD_SUCCESS:
      /* Pop the transitions window and refresh the issue list. */
      window_stack_pop(true);
      s_issue_count = 0;
      if (s_issues_menu) {
        layer_set_hidden(menu_layer_get_layer(s_issues_menu), true);
      }
      if (s_issues_status) {
        text_layer_set_text(s_issues_status, "Refreshing...");
        layer_set_hidden(text_layer_get_layer(s_issues_status), false);
      }
      request_issues();
      break;

    case CMD_ERROR: {
      Tuple *msg_t = dict_find(iter, KEY_MSG);
      const char *msg = msg_t ? msg_t->value->cstring : "An error occurred.";
      if (window_stack_get_top_window() == s_trans_window) {
        if (s_trans_menu) {
          layer_set_hidden(menu_layer_get_layer(s_trans_menu), true);
        }
        if (s_trans_status) {
          text_layer_set_text(s_trans_status, msg);
          layer_set_hidden(text_layer_get_layer(s_trans_status), false);
        }
      } else {
        if (s_issues_menu) {
          layer_set_hidden(menu_layer_get_layer(s_issues_menu), true);
        }
        if (s_issues_status) {
          text_layer_set_text(s_issues_status, msg);
          layer_set_hidden(text_layer_get_layer(s_issues_status), false);
        }
      }
      break;
    }

    default:
      break;
  }
}

static void inbox_dropped(AppMessageResult reason, void *ctx) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Message dropped: %d", (int)reason);
}

static void outbox_failed(DictionaryIterator *iter, AppMessageResult reason,
                          void *ctx) {
  APP_LOG(APP_LOG_LEVEL_ERROR, "Send failed: %d", (int)reason);
  if (s_issues_status) {
    text_layer_set_text(s_issues_status, "Failed to contact phone.");
    layer_set_hidden(text_layer_get_layer(s_issues_status), false);
  }
}

/* ════════════════════════════════════════════════════════════════
   Menu select callbacks
   ════════════════════════════════════════════════════════════════ */

static void request_issues(void) {
  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    int v = CMD_GET_ISSUES;
    dict_write_int(out, KEY_CMD, &v, sizeof(int), true);
    app_message_outbox_send();
  }
}

static void issues_select(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  if (s_issue_count == 0) return;
  s_selected_issue   = idx->row;
  s_transition_count = 0;

  /* Push transitions window; trans_window_load initialises the layers. */
  window_stack_push(s_trans_window, true);

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    int cmd = CMD_GET_TRANS;
    dict_write_int(out, KEY_CMD,   &cmd,              sizeof(int), true);
    dict_write_int(out, KEY_INDEX, &s_selected_issue, sizeof(int), true);
    app_message_outbox_send();
  }
}

static void trans_select(MenuLayer *ml, MenuIndex *idx, void *ctx) {
  if (s_transition_count == 0) return;
  int ti = idx->row;

  if (s_trans_menu) {
    layer_set_hidden(menu_layer_get_layer(s_trans_menu), true);
  }
  if (s_trans_status) {
    text_layer_set_text(s_trans_status, "Updating status...");
    layer_set_hidden(text_layer_get_layer(s_trans_status), false);
  }

  DictionaryIterator *out;
  if (app_message_outbox_begin(&out) == APP_MSG_OK) {
    int cmd = CMD_APPLY_TRANS;
    dict_write_int(out, KEY_CMD,     &cmd,              sizeof(int), true);
    dict_write_int(out, KEY_INDEX,   &s_selected_issue, sizeof(int), true);
    dict_write_cstring(out, KEY_TRANS_ID, s_transitions[ti].id);
    app_message_outbox_send();
  }
}

/* ════════════════════════════════════════════════════════════════
   App lifecycle
   ════════════════════════════════════════════════════════════════ */

static void init(void) {
  s_issues_window = window_create();
  window_set_window_handlers(s_issues_window, (WindowHandlers){
    .load   = issues_window_load,
    .unload = issues_window_unload,
  });

  s_trans_window = window_create();
  window_set_window_handlers(s_trans_window, (WindowHandlers){
    .load   = trans_window_load,
    .unload = trans_window_unload,
  });

  window_stack_push(s_issues_window, true);

  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_failed(outbox_failed);
  app_message_open(512, 512);

  request_issues();
}

static void deinit(void) {
  window_destroy(s_issues_window);
  window_destroy(s_trans_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
