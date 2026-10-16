import { createContext, useContext } from 'react';

import type { ConfigResponse } from '../../shared/types.ts';

export const ConfigContext = createContext<ConfigResponse>({
    shortOrigin: '',
    dashOrigin: '',
    version: '',
    reputation: false,
    abuseMinScore: 25
});

export const useConfig = () => useContext(ConfigContext);
