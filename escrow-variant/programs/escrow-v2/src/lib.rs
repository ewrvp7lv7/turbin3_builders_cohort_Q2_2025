pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DDPu4T2aHsNCwZQx5Q8ihL9M8y9WTTQzwHcrU9ptpmgb");

#[program]
pub mod escrow_v2 {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }
}
