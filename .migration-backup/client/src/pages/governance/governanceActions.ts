import type { AdminActionOption } from "./types";

export const ADMIN_ACTIONS: AdminActionOption[] = [
  {
    label: "Emergency Pause",
    method: "emergency_pause",
    description: "Pause all vault deposits and rebalancing operations.",
    fields: [],
  },
  {
    label: "Emergency Unpause",
    method: "emergency_unpause",
    description: "Resume vault operations after an emergency pause.",
    fields: [],
  },
  {
    label: "Set Keeper Fee",
    method: "set_keeper_fee",
    description: "Update the keeper incentive fee in basis points.",
    fields: [
      {
        name: "fee_bps",
        label: "Fee (bps)",
        type: "number",
        placeholder: "50",
        required: true,
      },
    ],
  },
  {
    label: "Set Fee Bounds",
    method: "set_fee_bounds",
    description: "Update the min/max performance fee bounds.",
    fields: [
      {
        name: "min_bps",
        label: "Min Fee (bps)",
        type: "number",
        placeholder: "100",
        required: true,
      },
      {
        name: "max_bps",
        label: "Max Fee (bps)",
        type: "number",
        placeholder: "1000",
        required: true,
      },
    ],
  },
  {
    label: "Register Keeper",
    method: "register_keeper",
    description: "Add a new keeper node to the registry.",
    fields: [
      {
        name: "keeper",
        label: "Keeper Address",
        type: "address",
        placeholder: "G...",
        required: true,
      },
    ],
  },
  {
    label: "Remove Keeper",
    method: "remove_keeper",
    description: "Remove a keeper node from the registry.",
    fields: [
      {
        name: "keeper",
        label: "Keeper Address",
        type: "address",
        placeholder: "G...",
        required: true,
      },
    ],
  },
  {
    label: "Rescue Funds",
    method: "rescue_funds",
    description: "Transfer funds to a target address in an emergency.",
    fields: [
      {
        name: "target",
        label: "Target Address",
        type: "address",
        placeholder: "G...",
        required: true,
      },
      {
        name: "amount",
        label: "Amount (stroops)",
        type: "number",
        placeholder: "1000000",
        required: true,
      },
    ],
  },
  {
    label: "Set Admin",
    method: "set_admin",
    description: "Initiate admin transfer with 24-hour timelock.",
    fields: [
      {
        name: "new_admin",
        label: "New Admin Address",
        type: "address",
        placeholder: "G...",
        required: true,
      },
    ],
  },
];
